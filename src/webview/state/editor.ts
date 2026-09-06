import { createContext, useCallback, useContext } from 'react';
import { EditorState, HostMessage, ProbeResult } from '../../shared/protocol';
import { ConnectionProfile } from '../../types';
import { PersistedUi, readPersisted, writePersisted } from './vscode';
import { Store, createStore, useStoreSelector } from './store';

export type Method = 'manual' | 'string';
export type AdvancedGroupId = 'transport' | 'network' | 'security' | 'session' | 'driver';

export interface ParseReport {
  ok: boolean;
  text: string;
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
  /** The production confirmation standing in front of a connect. */
  confirming: boolean;
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

export function initialState(): AppState {
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
    confirming: false
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

/** Reads one field of the draft. Undefined while nothing is selected. */
export function useField<K extends keyof ConnectionProfile>(key: K): ConnectionProfile[K] | undefined {
  return useSelect((state) => state.draft?.[key]);
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
    confirming: false
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

    case 'probe':
      return state.draft?.id === message.profileId ? { ...state, probe: message.result } : state;

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
  return { ...state, draft: { ...state.draft, [key]: value } };
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

export function toggleGroup(state: AppState, group: AdvancedGroupId): AppState {
  const advanced = { ...state.advanced, [group]: !state.advanced[group] };
  writePersisted({ advanced });
  return { ...state, advanced };
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

export function isValid(state: AppState): boolean {
  const draft = state.draft;
  return Boolean(draft && draft.name.trim() && draft.host.trim() && !portInvalid(draft.port));
}

export function portInvalid(port: number | null | undefined): boolean {
  return port !== null && port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535);
}

export function isBusy(state: AppState): boolean {
  return Boolean(state.draft && state.host.busy === state.draft.id);
}

export function isConnected(state: AppState): boolean {
  return Boolean(state.draft && state.host.connected.includes(state.draft.id));
}
