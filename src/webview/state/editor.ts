import { createContext, useCallback, useContext } from 'react';
import { EditorState, HostMessage, ProbeResult } from '../../shared/protocol';
import { ConnectionProfile, defaultPort, needsSecret, needsUser } from '../../types';
import { ParsedConnection, parseConnectionString } from '../lib/connectionString';
import { PersistedUi, readPersisted, writePersisted } from './vscode';
import { Store, createStore, useStoreSelector } from './store';

export type Method = 'manual' | 'string';
export type AdvancedGroupId = 'transport' | 'network' | 'security' | 'session' | 'driver';

export interface ParseReport {
  ok: boolean;
  text: string;
}

/** The fields validation can name. Every one is a box on the form. */
export type ValidatedField =
  | 'name'
  | 'host'
  | 'port'
  | 'user'
  | 'password'
  | 'clientCertPath'
  | 'clientKeyPath';

export interface Problem {
  field: ValidatedField;
  /** One sentence, in the form's own words: "Server is required". */
  message: string;
  /**
   * False when the field only stands between the draft and a live session.
   * A profile can be saved without a user name and finished later; it cannot
   * be saved without a name to file it under.
   */
  blocksSave: boolean;
}

export interface AppState {
  host: EditorState;
  /** The connection as it is being edited. Null when nothing is selected. */
  draft: ConnectionProfile | null;
  /** The connection as the host last saw it, which is what dirty measures against. */
  baseline: ConnectionProfile | null;
  /** Typed password. Undefined means untouched, so it is never sent. */
  secret: string | undefined;
  revealSecret: boolean;
  /** Databases read from the live server, or null when none have been. */
  databases: string[] | null;
  probe: ProbeResult | null;
  method: Method;
  advanced: Record<AdvancedGroupId, boolean>;
  parseText: string;
  parseReport: ParseReport | null;
  /**
   * True while the name in the draft is one a connection string supplied
   * rather than one the user typed. It is what lets a second string, pasted
   * after the first was tested, rename the draft, while a name that was typed
   * is never touched again.
   */
  nameFromString: boolean;
  /** The production confirmation standing in front of a connect. */
  confirming: boolean;
  /**
   * Fields the user has left, so a problem is shown on a box they have been
   * in rather than on every empty box of a form they just opened.
   */
  touched: Readonly<Record<string, true>>;
  /**
   * True once every problem should be shown at once: a stored connection was
   * opened, or a shortcut tried to act on a draft that was not ready. A brand
   * new draft starts false, so it opens quiet rather than red.
   */
  attempted: boolean;
}

const EMPTY_HOST: EditorState = {
  profiles: [],
  pending: null,
  selectedId: null,
  connected: [],
  busy: null,
  hasSecret: {},
  results: {},
  reload: false
};

const DEFAULT_GROUPS: Record<AdvancedGroupId, boolean> = {
  transport: false,
  network: false,
  security: false,
  session: false,
  driver: false
};

function initialState(): AppState {
  const saved: PersistedUi = readPersisted();
  return {
    host: EMPTY_HOST,
    draft: null,
    baseline: null,
    secret: undefined,
    revealSecret: false,
    databases: null,
    probe: null,
    method: saved.method === 'string' ? 'string' : 'manual',
    advanced: { ...DEFAULT_GROUPS, ...(saved.advanced as Record<AdvancedGroupId, boolean>) },
    parseText: '',
    parseReport: null,
    nameFromString: false,
    confirming: false,
    touched: {},
    attempted: false
  };
}

export type EditorStore = Store<AppState>;

export function createEditorStore(): EditorStore {
  return createStore(initialState());
}

export const StoreContext = createContext<EditorStore | null>(null);

export function useStore(): EditorStore {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error('The editor store is missing from the tree.');
  }
  return store;
}

export function useSelect<T>(select: (state: AppState) => T): T {
  return useStoreSelector(useStore(), select);
}

/**
 * Reads one field of the draft. Undefined while nothing is selected.
 *
 * The selector is held stable on `key` rather than written inline, for the
 * reason `sidebar/state.ts` sets out: `useStoreSelector` memoises its snapshot
 * on the selector's identity, so a fresh arrow every render makes React treat
 * the store as possibly-changed and re-run its consistency check and a passive
 * effect for that hook on every pass. One control would never show it. The
 * advanced groups alone build about fifty.
 */
export function useField<K extends keyof ConnectionProfile>(key: K): ConnectionProfile[K] | undefined {
  const select = useCallback((state: AppState) => state.draft?.[key], [key]);
  return useStoreSelector(useStore(), select);
}

/** The problem to draw under a box, or undefined while it should stay quiet. */
export function useProblem(field: ValidatedField): string | undefined {
  const select = useCallback((state: AppState) => shownProblem(state, field), [field]);
  return useStoreSelector(useStore(), select);
}

export function useUpdate(): (update: (state: AppState) => AppState) => void {
  const store = useStore();
  return useCallback((update) => store.setState(update), [store]);
}

/* ------------------------------------------------------------ transitions */

function profileById(host: EditorState, id: string | null): ConnectionProfile | null {
  if (!id) {
    return null;
  }
  if (host.pending && host.pending.id === id) {
    return host.pending;
  }
  return host.profiles.find((p) => p.id === id) ?? null;
}

/**
 * A profile is data and one array of pairs, so a deep copy is this and no
 * more. Written out rather than reached for a structured clone, which is both
 * slower and a dependency on the host being new enough to have one.
 */
function cloneProfile(profile: ConnectionProfile): ConnectionProfile {
  return { ...profile, properties: profile.properties.map((property) => ({ ...property })) };
}

function loadDraft(state: AppState, host: EditorState): AppState {
  const profile = profileById(host, host.selectedId);
  const fresh = Boolean(profile && host.pending && host.pending.id === profile.id);
  return {
    ...state,
    host,
    baseline: profile,
    draft: profile ? cloneProfile(profile) : null,
    secret: undefined,
    revealSecret: false,
    databases: null,
    probe: null,
    parseText: '',
    parseReport: null,
    nameFromString: false,
    confirming: false,
    touched: {},
    // A stored connection that is missing something says so the moment it is
    // opened; a new one is allowed to be empty until it has been typed in.
    attempted: !fresh
  };
}

/** Folds a message from the host into the state. */
export function applyHostMessage(state: AppState, message: HostMessage): AppState {
  switch (message.type) {
    case 'state': {
      const { type: _ignored, ...host } = message;
      const moved = host.selectedId !== state.host.selectedId;
      if (host.reload || moved || !state.draft || state.draft.id !== host.selectedId) {
        return loadDraft(state, host);
      }
      // A redraw that does not touch the selection leaves the draft alone; the
      // user may be mid-word in it.
      return { ...state, host, baseline: profileById(host, host.selectedId) ?? state.baseline };
    }

    case 'databases':
      return state.draft?.id === message.profileId ? { ...state, databases: message.databases } : state;

    case 'patch':
      return state.draft?.id === message.profileId
        ? { ...state, draft: { ...state.draft, ...message.patch } }
        : state;

    case 'probe': {
      // The reply carries the address it was asked about, and a lookup that
      // took a while can land after the box has moved on. Matching the profile
      // alone let an answer for a host nobody is looking at any more paint
      // itself under the one they are, which is the one reading on this page
      // that has to be true or say nothing.
      if (state.draft?.id !== message.profileId) {
        return state;
      }
      const current = `${(state.draft.host ?? '').trim()}|${state.draft.port ?? ''}`;
      return message.result.target === current ? { ...state, probe: message.result } : state;
    }

    default:
      return state;
  }
}

export function setField<K extends keyof ConnectionProfile>(
  state: AppState,
  key: K,
  value: ConnectionProfile[K]
): AppState {
  if (!state.draft || state.draft[key] === value) {
    return state;
  }
  return {
    ...state,
    draft: { ...state.draft, [key]: value },
    // Typing in the name box makes the name the user's, and a later string
    // stops being allowed to rewrite it.
    nameFromString: key === 'name' ? false : state.nameFromString
  };
}

/** The user has left a box, so a problem with it may now be shown. */
export function touch(state: AppState, field: string): AppState {
  if (state.touched[field]) {
    return state;
  }
  return { ...state, touched: { ...state.touched, [field]: true } };
}

/** Every problem should be shown: something tried to act on the draft. */
export function markAttempted(state: AppState): AppState {
  return state.attempted ? state : { ...state, attempted: true };
}

/**
 * Switching away from a parse leaves the fields exactly as they are; the two
 * views describe one connection, not two. The outcome of a parse survives the
 * move back to the fields, because that is where the outcome has to be read.
 */
export function setMethod(state: AppState, method: Method): AppState {
  writePersisted({ method });
  return { ...state, method };
}

/** Where the user goes after a string is laid over the draft. */
export type ApplyMode = 'fields' | 'direct';

/**
 * Lays a parsed connection string over the draft.
 *
 * Both ways of using a string end here, and that is the point: `fields` hands
 * the editor back to the boxes so the reading can be corrected, `direct` acts
 * on the string where it was pasted. One function means the two can never
 * disagree about what a string meant, which is what would make the direct
 * route untrustworthy.
 *
 * It is pure in `direct` mode, so the panel can run it to show what the
 * string resolves to before anything is committed.
 */
export function applyParsed(state: AppState, parsed: ParsedConnection, mode: ApplyMode): AppState {
  if (!state.draft) {
    return state;
  }

  const switched = parsed.patch.driver !== state.draft.driver;
  const patch = { ...parsed.patch };
  // A port carried over from the other engine would be wrong, and the
  // string did not mention one.
  if (switched && patch.port === undefined && patch.driver) {
    patch.port = defaultPort(patch.driver);
  }

  const draft: ConnectionProfile = {
    ...state.draft,
    ...patch,
    properties: mergeProperties(state.draft.properties, parsed.properties)
  };

  // Saving straight from the string never passes the name box, so the list
  // would fill with "New SQL Server connection". The string named a server and
  // a database; that reads better in the sidebar than a counter. Only ever
  // when the host's generated name is still untouched: a typed name is the
  // user's and is never overwritten.
  const named = mode === 'direct' && untouchedName(state) ? nameFromTarget(state, draft) : null;
  if (named) {
    draft.name = named;
  }

  const filled = Object.keys(patch).filter((key) => key !== 'driver').length;
  const lines = [`Filled ${filled} ${filled === 1 ? 'field' : 'fields'} from a ${parsed.engine} string.`];
  if (switched) {
    lines.push(`The server type was switched to ${parsed.engine}.`);
  }
  if (parsed.secret !== undefined) {
    lines.push('The password went into the password box.');
  }
  if (named) {
    lines.push(`Named it ${named}.`);
  }
  if (parsed.properties.length) {
    lines.push(`Kept as driver properties: ${parsed.properties.map((p) => p.name).join(', ')}.`);
  }

  const next: AppState = {
    ...state,
    draft,
    secret: parsed.secret !== undefined ? parsed.secret : state.secret,
    // The direct route keeps the text: it is the thing being acted on, and a
    // failed attempt is corrected by editing it rather than by pasting again.
    parseText: mode === 'direct' ? state.parseText : '',
    parseReport: { ok: true, text: lines.join(' ') },
    nameFromString: named ? true : state.nameFromString,
    // The fields were just filled in, so what is still missing is worth
    // saying on the boxes themselves.
    attempted: mode === 'fields' ? true : state.attempted
  };
  return mode === 'direct' ? next : setMethod(next, 'manual');
}

/** True while nobody has typed a name of their own over the generated one. */
function untouchedName(state: AppState): boolean {
  return isNew(state) && (state.nameFromString || state.baseline?.name === state.draft?.name);
}

/**
 * Driver keywords from the string laid over the ones already held, matched by
 * name. Appending instead would double every keyword the second time a button
 * in the string card is pressed, and the string is the later word on a keyword
 * both of them carry.
 */
function mergeProperties(
  held: ConnectionProfile['properties'],
  incoming: ConnectionProfile['properties']
): ConnectionProfile['properties'] {
  if (!incoming.length) {
    return held;
  }
  const merged = held.map((property) => ({ ...property }));
  for (const property of incoming) {
    const at = merged.findIndex((one) => one.name.toLowerCase() === property.name.toLowerCase());
    if (at === -1) {
      merged.push({ ...property });
    } else {
      merged[at] = { ...property };
    }
  }
  return merged;
}

/**
 * A name the string itself argues for. Kept clear of names already in the
 * list, because the host refuses a duplicate and a direct save has no field
 * to show that refusal against.
 */
function nameFromTarget(state: AppState, draft: ConnectionProfile): string | null {
  const host = draft.host.trim();
  if (!host) {
    return null;
  }
  const database = draft.database.trim();
  const base = database ? `${database} on ${host}` : host;
  const taken = new Set(state.host.profiles.map((profile) => profile.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) {
    return base;
  }
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return base;
}

/*
 * One-entry memos for `effective` and `problems`.
 *
 * A selector has to hand `useSyncExternalStore` the same object every time it
 * is asked about the same state, or React redraws in a loop, and several
 * components ask these questions. The store replaces the whole state object on
 * every change, so the identity of the input is the whole of the key.
 */
let lastEffectiveInput: AppState | null = null;
let lastEffectiveOutput: AppState | null = null;

/**
 * The draft an action would actually run against: the fields, with a
 * recognised string from the paste box laid over them.
 *
 * This is what lets one set of buttons serve both ways of describing a
 * connection. Test, Save and Connect never learned about strings; they read
 * the draft, and a string that parses is part of the draft from the moment one
 * of them is pressed. A string that does not parse, or a paste box that is not
 * the pane in front of the user, changes nothing.
 */
export function effective(state: AppState): AppState {
  if (lastEffectiveInput === state && lastEffectiveOutput) {
    return lastEffectiveOutput;
  }
  const parsed = state.method === 'string' ? parseConnectionString(state.parseText) : null;
  const output = parsed ? applyParsed(state, parsed, 'direct') : state;
  lastEffectiveInput = state;
  lastEffectiveOutput = output;
  return output;
}

export function toggleGroup(state: AppState, group: AdvancedGroupId): AppState {
  const advanced = { ...state.advanced, [group]: !state.advanced[group] };
  writePersisted({ advanced });
  return { ...state, advanced };
}

/* ------------------------------------------------------------- validation */

let lastProblemsInput: AppState | null = null;
let lastProblemsOutput: Problem[] = [];

/**
 * Everything that stands between the draft and a live session, in the order
 * the form lays the boxes out.
 *
 * The rules are the drivers' own, not guesses. A SQL login and an NTLM login
 * both hand tedious a user name and a password; an Entra login hands it a
 * token from the account provider and needs neither. node-postgres logs a
 * `trust` or `peer` role in with no credential and falls back to the operating
 * system user for the name, so both are optional there; a certificate login
 * has to be able to read both halves of the key pair. The NTLM domain is
 * optional because the driver takes an empty one and the host's DNS domain is
 * sent in its place.
 *
 * A password is only *required* while the profile keeps its credential in the
 * keychain and the keychain does not have one yet. A profile that asks every
 * time will ask, which is the point of that setting.
 */
export function problems(state: AppState): Problem[] {
  if (lastProblemsInput === state) {
    return lastProblemsOutput;
  }
  const out: Problem[] = [];
  const draft = state.draft;
  if (draft) {
    const name = draft.name.trim().toLowerCase();
    if (!name) {
      out.push({ field: 'name', message: 'Connection name is required', blocksSave: true });
    } else if (
      state.host.profiles.some((p) => p.id !== draft.id && p.name.trim().toLowerCase() === name)
    ) {
      out.push({ field: 'name', message: 'Another connection already has this name', blocksSave: true });
    }
    if (!draft.host.trim()) {
      out.push({ field: 'host', message: 'Server is required', blocksSave: true });
    }
    if (portInvalid(draft.port)) {
      out.push({ field: 'port', message: 'Port must be between 1 and 65535', blocksSave: true });
    }
    if (needsUser(draft) && !draft.user.trim()) {
      out.push({ field: 'user', message: 'User name is required', blocksSave: false });
    }
    if (passwordMissing(state)) {
      out.push({ field: 'password', message: 'Password is required', blocksSave: false });
    }
    if (draft.driver === 'postgres' && draft.pgAuth === 'certificate') {
      if (!draft.clientCertPath.trim()) {
        out.push({ field: 'clientCertPath', message: 'Client certificate path is required', blocksSave: false });
      }
      if (!draft.clientKeyPath.trim()) {
        out.push({ field: 'clientKeyPath', message: 'Client key path is required', blocksSave: false });
      }
    }
  }
  lastProblemsInput = state;
  lastProblemsOutput = out;
  return out;
}

/** True when a session needs a password nobody has supplied yet. */
export function passwordMissing(state: AppState): boolean {
  const draft = state.draft;
  if (!draft || !needsSecret(draft) || draft.credentialStore !== 'secret') {
    return false;
  }
  const typed = state.secret !== undefined && state.secret !== '';
  return !typed && !state.host.hasSecret[draft.id];
}

export function problemFor(state: AppState, field: ValidatedField): Problem | undefined {
  return problems(state).find((problem) => problem.field === field);
}

/** The problem a box should be drawing right now, once the user has been in it. */
function shownProblem(state: AppState, field: ValidatedField): string | undefined {
  if (!state.attempted && !state.touched[field]) {
    return undefined;
  }
  return problemFor(state, field)?.message;
}

/** The draft can be filed under a name, at an address. */
export function canSave(state: AppState): boolean {
  return Boolean(state.draft) && !problems(state).some((problem) => problem.blocksSave);
}

/** The draft can be handed to a driver. */
export function canConnect(state: AppState): boolean {
  return Boolean(state.draft) && problems(state).length === 0;
}

/** "Server and password are missing", for a button that cannot be pressed. */
export function missingSummary(state: AppState, forSave = false): string | undefined {
  const names = problems(state)
    .filter((problem) => !forSave || problem.blocksSave)
    .map((problem) => problem.message.replace(/ (is|must be|already has).*$/, '').toLowerCase());
  if (names.length === 0) {
    return undefined;
  }
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${names.length === 1 ? 'is' : 'are'} still needed`;
}

/* --------------------------------------------------------------- readings */

export function isNew(state: AppState): boolean {
  return Boolean(state.draft && state.host.pending && state.host.pending.id === state.draft.id);
}

/** Fields that never travel to the host, and so never count as a change. */
function comparable(profile: ConnectionProfile): string {
  const { updatedAt: _updatedAt, ...rest } = profile;
  return JSON.stringify(rest);
}

export function isDirty(state: AppState): boolean {
  if (!state.draft || !state.baseline) {
    return false;
  }
  if (state.secret !== undefined) {
    return true;
  }
  return comparable(state.draft) !== comparable(state.baseline);
}

export function portInvalid(port: number | null | undefined): boolean {
  return port !== null && port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535);
}

export function isConnected(state: AppState): boolean {
  return Boolean(state.draft && state.host.connected.includes(state.draft.id));
}
