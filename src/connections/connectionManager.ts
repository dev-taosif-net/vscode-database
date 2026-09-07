import * as vscode from 'vscode';
import { ConnectionStore } from '../store/connectionStore';
import { MssqlDriver } from '../drivers/mssql';
import { PostgresDriver } from '../drivers/postgres';
import { describeFailure } from '../drivers/errors';
import { ConnectSecrets, Driver, DriverSession } from '../drivers/types';
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
    void this.disconnectAll();
    this.onDidChangeEmitter.dispose();
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

  activeIds(): string[] {
    return [...this.active.keys()].filter((id) => this.isConnected(id));
  }

  isBusy(profileId: string): boolean {
    return this.inFlight.has(profileId);
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

  async disconnect(profileId: string): Promise<void> {
    const entry = this.active.get(profileId);
    if (!entry) {
      return;
    }
    this.active.delete(profileId);
    await entry.session.close();
    this.output.info(`Disconnected ${profileId}`);
    this.onDidChangeEmitter.fire();
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
    this.inFlight.set(profile.id, { controller, kind: keep ? 'connect' : 'test' });
    // The list draws a spinner from this, so it has to hear about the attempt
    // when it starts and not only when it lands.
    this.onDidChangeEmitter.fire();

    try {
      const driver = this.driverFor(profile);
      const secrets = await this.resolveSecrets(profile, true, secretOverride);
      const opened = await driver.open(profile, secrets, controller.signal);

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
      this.active.set(profile.id, { session: opened.session, info });
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
      this.inFlight.delete(profile.id);
      this.onDidChangeEmitter.fire();
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
      const error = new Error('The connection attempt was cancelled.');
      error.name = 'AbortError';
      throw error;
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
