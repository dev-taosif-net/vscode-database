/**
 * The contract between the extension host and the connection editor.
 *
 * Both sides compile against this file, so a message that changes shape breaks
 * the build rather than the editor. Nothing here may import `vscode`: the
 * webview is a browser and has no access to it.
 */
import { ConnectionFailure, ConnectionInfo, ConnectionProfile, DriverKind, FailureActionId } from '../types';

/** What a test or a connect attempt came back with. */
export type AttemptOutcome =
  | { ok: true; info: ConnectionInfo }
  | { ok: false; failure: ConnectionFailure };

/** How far a live check of the server address got. */
export type ProbeState = 'idle' | 'checking' | 'resolved' | 'reachable' | 'unresolved' | 'unreachable';

export interface ProbeResult {
  /** The host and port the answer belongs to, so a stale reply is ignored. */
  target: string;
  state: ProbeState;
  /** The address the name resolved to, when it did. */
  address?: string;
  /** Round trip of the reachability check, in milliseconds. */
  latencyMs?: number;
  message?: string;
}

/** Everything the editor draws from. Sent whole; the editor diffs it itself. */
export interface EditorState {
  profiles: ConnectionProfile[];
  /** A connection being written that the store has never seen. */
  pending: ConnectionProfile | null;
  selectedId: string | null;
  connected: string[];
  busy: string | null;
  hasSecret: Record<string, boolean>;
  results: Record<string, AttemptOutcome>;
  /** True when the editor should throw away its draft and reload from this. */
  reload: boolean;
}

export type HostMessage =
  | ({ type: 'state' } & EditorState)
  | { type: 'databases'; profileId: string; databases: string[] }
  | { type: 'patch'; profileId: string; patch: Partial<ConnectionProfile> }
  | { type: 'probe'; profileId: string; result: ProbeResult }
  | { type: 'focusSearch' };

/** A draft as the editor holds it, with the typed password kept apart. */
export interface DraftPayload {
  id: string;
  patch: Partial<ConnectionProfile>;
  /** Undefined means untouched; an empty string means "forget the stored one". */
  secret?: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'create'; driver: DriverKind }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'menu'; id: string }
  | ({ type: 'save' } & DraftPayload)
  | { type: 'revert'; id: string }
  | ({ type: 'test' } & DraftPayload)
  | ({ type: 'connect' } & DraftPayload)
  | { type: 'disconnect'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'close' }
  | ({ type: 'reloadDatabases' } & DraftPayload)
  | { type: 'clearSecret'; id: string }
  | { type: 'signIn'; id: string }
  | { type: 'action'; id: string; actionId: FailureActionId; raw: string }
  | { type: 'probe'; id: string; host: string; port: number | null };
