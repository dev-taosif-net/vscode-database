import * as vscode from 'vscode';
import { ConnectionStore } from '../store/connectionStore';
import { MssqlDriver } from '../drivers/mssql';
import { PostgresDriver } from '../drivers/postgres';
import { describeFailure } from '../drivers/errors';
import { ConnectSecrets, Driver, DriverSession, abortError } from '../drivers/types';
import {
  ConnectionFailure,
  ConnectionInfo,
  ConnectionProfile,
  needsSecret,
  needsUser
} from '../types';

/** The audience Azure SQL and SQL Server on Entra both accept a token for. */
const SQL_SCOPES = ['https://database.windows.net/.default', 'offline_access'];

export type AttemptResult =
  | { ok: true; info: ConnectionInfo }
  | { ok: false; failure: ConnectionFailure };

interface ActiveConnection {
  session: DriverSession;
  info: ConnectionInfo;
  /**
   * What opened it, kept so the pool can open a second session to the same
   * place without asking again.
   *
   * Holding a credential in memory for the life of a connection is not a new
   * exposure: the driver holding the socket has held the same value since it
   * opened, and the alternative is a password box appearing the first time
   * somebody presses Run on a connection that is already open. It is dropped
   * with the session, in `disconnect`.
   */
  secrets: ConnectSecrets;
}

/**
 * An attempt that has not landed yet. The kind is kept because the sidebar
 * draws "Connecting" and "Testing" differently: only one of them ends in a
 * session, and a row that says the wrong one is a row that lies.
 */
interface InFlight {
  controller: AbortController;
  kind: AttemptKind;
}

export type AttemptKind = 'connect' | 'test';

/**
 * Everything between "the user pressed Connect" and "there is a session".
 * Owns credential resolution, the production guard, error translation, and the
 * set of open sessions.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly drivers = new Map<ConnectionProfile['driver'], Driver>([
    ['mssql', new MssqlDriver()],
    ['postgres', new PostgresDriver()]
  ]);

  private readonly active = new Map<string, ActiveConnection>();
  private readonly inFlight = new Map<string, InFlight>();
  /** Profile id to the title of its last failure, cleared by a success. */
  private readonly failures = new Map<string, string>();

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly output: vscode.LogOutputChannel
  ) {}

  dispose(): void {
    // The emitter goes first: a listener that hears about sessions closing
    // during deactivation would be told to redraw a window that is going away.
    this.onDidChangeEmitter.dispose();
    void this.disconnectAll();
  }

  /** Why the last attempt failed, for as long as nothing has succeeded since. */
  lastFailure(profileId: string): string | undefined {
    return this.failures.get(profileId);
  }

  /**
   * Drops every remembered failure. It forgets them and nothing else: no
   * attempt is retried, so a row that stops saying it failed is a row nobody
   * has tried since, not a row that has quietly succeeded. That distinction is
   * the entire honesty of the Refresh action, which is the only caller.
   */
  clearFailures(): void {
    if (this.failures.size === 0) {
      return;
    }
    this.failures.clear();
    this.onDidChangeEmitter.fire();
  }

  isConnected(profileId: string): boolean {
    const entry = this.active.get(profileId);
    return entry !== undefined && !entry.session.isClosed();
  }

  infoFor(profileId: string): ConnectionInfo | undefined {
    return this.active.get(profileId)?.info;
  }

  /**
   * The live session, for the catalog to read the object tree through.
   *
   * It hands out the session rather than proxying every statement, because the
   * manager has no opinion about catalog SQL and a pass-through method per
   * query would be a second place for the closed-session check to live. A
   * session that has closed underneath us is returned as undefined, so a caller
   * cannot act on a socket that is already gone.
   */
  sessionFor(profileId: string): DriverSession | undefined {
    const entry = this.active.get(profileId);
    return entry && !entry.session.isClosed() ? entry.session : undefined;
  }

  activeIds(): string[] {
    return [...this.active.keys()].filter((id) => this.isConnected(id));
  }

  /** Which kind of attempt is in flight, or undefined when none is. */
  busyKind(profileId: string): AttemptKind | undefined {
    return this.inFlight.get(profileId)?.kind;
  }

  cancel(profileId: string): void {
    this.inFlight.get(profileId)?.controller.abort();
  }

  /**
   * Opens a session, reports on it, then closes it again. Nothing is kept, so
   * a test never leaves a connection behind on the server.
   */
  async test(
    profile: ConnectionProfile,
    overrides?: Partial<ConnectionProfile>,
    secretOverride?: string
  ): Promise<AttemptResult> {
    const effective = overrides ? { ...profile, ...overrides } : profile;
    return this.attempt(effective, false, secretOverride);
  }

  /** Opens the same way a test does, and keeps the session that comes back. */
  async connect(profile: ConnectionProfile, secretOverride?: string): Promise<AttemptResult> {
    if (profile.environment === 'prod' && this.shouldConfirmProduction()) {
      const approved = await this.confirmProduction(profile);
      if (!approved) {
        return {
          ok: false,
          failure: {
            kind: 'cancelled',
            title: 'Connection cancelled.',
            detail: 'Nothing was opened against production.',
            actions: [],
            raw: ''
          }
        };
      }
    }

    return this.attempt(profile, true, secretOverride);
  }

  /**
   * Opens another session to a connection that is already open.
   *
   * The pool asks for these. It is deliberately not `connect`: it registers
   * nothing, fires no change event, skips the production confirmation the user
   * has already answered, and never prompts — a session opened behind a Run
   * must not put a password box in front of somebody. It refuses when the
   * connection is not open, because a second session to a server nobody has
   * connected to is a connection nobody authorised.
   */
  async openAuxiliary(profileId: string): Promise<DriverSession> {
    const entry = this.active.get(profileId);
    const profile = this.store.get(profileId);
    if (!entry || !profile) {
      throw new Error('The connection is not open.');
    }
    const opened = await this.driverFor(profile).open(profile, entry.secrets);
    return opened.session;
  }

  async disconnect(profileId: string): Promise<void> {
    const entry = this.active.get(profileId);
    if (!entry) {
      return;
    }
    this.active.delete(profileId);
    try {
      await entry.session.close();
    } catch (error) {
      // The socket is gone either way. What must not be lost is the event: a
      // close that threw used to leave the row drawn as connected.
      this.output.warn(`Closing ${profileId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.output.info(`Disconnected ${profileId}`);
      this.onDidChangeEmitter.fire();
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  /**
   * The database list, read from the live session when there is one and from a
   * throwaway connection when there is not.
   */
  async listDatabases(profile: ConnectionProfile, secretOverride?: string): Promise<string[]> {
    const entry = this.active.get(profile.id);
    if (entry && !entry.session.isClosed()) {
      return entry.session.listDatabases();
    }

    const driver = this.driverFor(profile);
    const secrets = await this.resolveSecrets(profile, true, secretOverride);
    const result = await driver.open(profile, secrets);
    try {
      return await result.session.listDatabases();
    } finally {
      await result.session.close();
    }
  }

  private async attempt(
    profile: ConnectionProfile,
    keep: boolean,
    secretOverride?: string
  ): Promise<AttemptResult> {
    const existing = this.inFlight.get(profile.id);
    if (existing) {
      existing.controller.abort();
    }
    const controller = new AbortController();
    const entry: InFlight = { controller, kind: keep ? 'connect' : 'test' };
    this.inFlight.set(profile.id, entry);
    // The list draws a spinner from this, so it has to hear about the attempt
    // when it starts and not only when it lands.
    this.onDidChangeEmitter.fire();

    try {
      const driver = this.driverFor(profile);
      const secrets = await this.resolveSecrets(profile, true, secretOverride);
      const opened = await this.openWithReprompt(driver, profile, secrets, controller.signal, secretOverride);

      // A cancel that lands while the server is answering still opens a
      // session, and a driver is free to resolve rather than reject on it. The
      // session is real, so it has to be closed rather than dropped, and the
      // attempt has to report as cancelled: keeping it would file a result the
      // user asked not to have, under an id a newer attempt may already own.
      if (controller.signal.aborted) {
        await opened.session.close().catch(() => undefined);
        throw abortError();
      }

      const info: ConnectionInfo = {
        profileId: profile.id,
        serverVersion: opened.serverVersion,
        principal: opened.principal,
        latencyMs: opened.latencyMs,
        readOnly: opened.readOnlyApplied || profile.readOnly,
        connectedAt: Date.now()
      };

      this.failures.delete(profile.id);

      if (!keep) {
        // A test proves the round trip and then leaves nothing behind on the
        // server. That is the whole difference between Test and Connect.
        await opened.session.close();
        this.output.info(`Tested ${profile.name} in ${opened.latencyMs} ms as ${opened.principal}`);
        return { ok: true, info };
      }

      // A second session for the same profile would leak the first one.
      const previous = this.active.get(profile.id);
      if (previous) {
        await previous.session.close();
      }
      this.active.set(profile.id, { session: opened.session, info, secrets });
      this.output.info(
        `Connected ${profile.name} (${profile.driver}) in ${opened.latencyMs} ms as ${opened.principal}`
      );
      return { ok: true, info };
    } catch (error) {
      const failure = describeFailure(profile, error);
      if (failure.kind !== 'cancelled') {
        this.output.error(`${profile.name}: ${failure.title} ${failure.raw}`);
        this.failures.set(profile.id, failure.title);
      }
      return { ok: false, failure };
    } finally {
      // Only if this attempt is still the one in flight. A superseded attempt
      // settles after its replacement has registered, and deleting the entry
      // unconditionally cleared the newer attempt's spinner and made
      // `cancel` a no-op on a connection that was very much still connecting.
      if (this.inFlight.get(profile.id) === entry) {
        this.inFlight.delete(profile.id);
      }
      this.onDidChangeEmitter.fire();
    }
  }

  /**
   * Opens the session, and asks for the credential again when a *stored* one
   * is what the server refused.
   *
   * The profile's "ask again when a stored credential is rejected" flag lives
   * here. A password that was typed into the editor for this attempt is left
   * alone — the editor shows the failure beside the box it was typed into —
   * and a prompted one was already the user's second word on the matter.
   */
  private async openWithReprompt(
    driver: Driver,
    profile: ConnectionProfile,
    secrets: ConnectSecrets,
    signal: AbortSignal,
    secretOverride: string | undefined
  ) {
    try {
      return await driver.open(profile, secrets, signal);
    } catch (error) {
      const stored =
        profile.repromptOnReject &&
        profile.credentialStore === 'secret' &&
        needsSecret(profile) &&
        !secretOverride &&
        secrets.password !== undefined;
      if (!stored || signal.aborted || describeFailure(profile, error).kind !== 'login') {
        throw error;
      }
      await this.store.writeSecret(profile.id, undefined);
      const again = await this.resolveSecrets(profile, true);
      return driver.open(profile, again, signal);
    }
  }

  private driverFor(profile: ConnectionProfile): Driver {
    const driver = this.drivers.get(profile.driver);
    if (!driver) {
      throw new Error(`No driver for ${profile.driver}`);
    }
    return driver;
  }

  /**
   * Produces whatever the driver needs to authenticate. Interactive prompting
   * is allowed only when the user asked for this attempt, so background work
   * can never pop a password box.
   */
  private async resolveSecrets(
    profile: ConnectionProfile,
    interactive: boolean,
    secretOverride?: string
  ): Promise<ConnectSecrets> {
    if (profile.driver === 'mssql' && profile.mssqlAuth === 'entra-mfa') {
      const session = await vscode.authentication.getSession('microsoft', this.entraScopes(profile), {
        createIfNone: interactive,
        silent: !interactive
      });
      if (!session) {
        throw new Error(
          'No Microsoft account is signed in for this connection. Sign in through the accounts menu and try again.'
        );
      }
      return { accessToken: session.accessToken };
    }

    if (!needsSecret(profile)) {
      return {};
    }

    // A password typed into the editor but not yet saved wins for this attempt,
    // which is what lets someone test a credential before committing it.
    if (secretOverride !== undefined && secretOverride !== '') {
      return { password: secretOverride };
    }

    if (profile.credentialStore === 'secret') {
      const stored = await this.store.readSecret(profile);
      if (stored !== undefined) {
        return { password: stored };
      }
    }

    if (!interactive) {
      return {};
    }

    const label = needsUser(profile) && profile.user ? ` for ${profile.user}` : '';
    const entered = await vscode.window.showInputBox({
      title: `Password${label}`,
      prompt: `${profile.name || profile.host} · ${profile.database || 'default database'}`,
      password: true,
      ignoreFocusOut: true
    });
    if (entered === undefined) {
      throw abortError();
    }
    if (profile.credentialStore === 'secret') {
      await this.store.writeSecret(profile.id, entered);
    }
    return { password: entered };
  }

  /**
   * Picks the Microsoft account this connection signs in with, and hands back
   * the label so the editor can show which one was chosen. Interactive by
   * definition: it exists because the user pressed a button asking for it.
   */
  async signIn(profile: ConnectionProfile): Promise<string | undefined> {
    const session = await vscode.authentication.getSession('microsoft', this.entraScopes(profile), {
      createIfNone: true,
      clearSessionPreference: true
    });
    return session?.account.label;
  }

  private entraScopes(profile: ConnectionProfile): string[] {
    // The built-in Microsoft provider reads the tenant out of the scope list.
    return profile.tenant ? [...SQL_SCOPES, `VSCODE_TENANT:${profile.tenant}`] : SQL_SCOPES;
  }

  private shouldConfirmProduction(): boolean {
    return vscode.workspace.getConfiguration('databaseTools').get<boolean>('confirmProductionConnect', true);
  }

  private async confirmProduction(profile: ConnectionProfile): Promise<boolean> {
    const target = `${profile.host}${profile.port ? `:${profile.port}` : ''} · ${profile.database || 'default database'}`;
    const detail = profile.readOnly
      ? `${target}\n\nThe session opens read-only.`
      : `${target}\n\nRead-only is off for this profile, so this session can write.`;
    const choice = await vscode.window.showWarningMessage(
      `Open a production session against ${profile.name}?`,
      { modal: true, detail },
      'Connect to production'
    );
    return choice === 'Connect to production';
  }
}
