/**
 * The contract between the extension host and the connections sidebar.
 *
 * Both sides compile against this file, so a message that changes shape breaks
 * the build rather than the panel. Nothing here may import `vscode`: the
 * sidebar is a browser and has no access to it.
 *
 * The sidebar is sent a projection rather than the profiles themselves. A
 * `ConnectionProfile` carries forty fields, most of them credential-adjacent —
 * the login name, the Entra account, the NTLM domain, three certificate paths.
 * A list that draws a name, a host and a badge has no business holding any of
 * them, and a projection means a bug in the panel cannot leak one. It also
 * keeps the message small: two hundred rows of ten fields, not two hundred
 * profiles of forty.
 */
import { DriverKind, EnvironmentId } from '../types';

/**
 * What the row is doing right now.
 *
 * `connecting` and `testing` are both in flight, and they are kept apart
 * because only one of them ends in a session. `failed` outlives the attempt
 * that produced it and is cleared by the next success, so a row that failed an
 * hour ago still says so.
 */
export type ConnectionState = 'connected' | 'connecting' | 'testing' | 'failed' | 'saved';

/** The live session, as much of it as a list row can use. */
export interface SessionFacts {
  serverVersion: string;
  principal: string;
  latencyMs: number;
  readOnly: boolean;
  connectedAt: number;
}

/**
 * The structural half of a row: everything that survives a session change.
 *
 * The state, the failure and the session facts are deliberately not here. They
 * are what changes when a connection opens, and while they were on this object
 * a single connect rebuilt the whole array, which rebuilt the flattened index,
 * which handed every windowed row a new identity — thirty re-renders for a
 * change that visually touches one row.
 */
export interface ConnectionRow {
  id: string;
  name: string;
  driver: DriverKind;
  environment: EnvironmentId;
  host: string;
  port: number | null;
  database: string;
  favourite: boolean;
  /** Profile-level intent. The session's own answer is on `SessionFacts`. */
  readOnly: boolean;
  updatedAt: number;
}

/** The volatile half, sent on its own so a connect never rebuilds the index. */
export interface SessionUpdate {
  id: string;
  state: Exclude<ConnectionState, 'saved'>;
  /** The title of the last failure, present only while `state` is `failed`. */
  failure?: string;
  /** Present only while `state` is `connected`. */
  session?: SessionFacts;
}

export type SortOrder = 'environment' | 'name' | 'recent';

/**
 * Everything the sidebar draws from. Sent whole; the panel diffs it itself.
 *
 * The search text is deliberately absent. It lives in the panel, because a
 * filter that round-trips to the host on every keystroke is a filter that
 * stutters at two hundred rows.
 */
export interface SidebarState {
  rows: ConnectionRow[];
  selectedId: string | null;
  grouped: boolean;
  sort: SortOrder;
  /** Environments the user has folded away, remembered across sessions. */
  collapsed: EnvironmentId[];
}

export type SidebarHostMessage =
  /** Sent on a store change and on `ready`. Never on a session change. */
  | ({ type: 'state' } & SidebarState)
  /**
   * Sent on a manager change. `active` carries every row that is not `saved`;
   * a row absent from it is saved. The panel replaces its whole session map,
   * so there is no diff to get wrong, and the message is a handful of entries
   * rather than two hundred rows.
   */
  | { type: 'sessions'; active: SessionUpdate[] }
  /** The title-bar Search action, routed to the box inside the panel. */
  | { type: 'focusSearch' }
  /** The title-bar Clear action. The box owns the text, so it is told. */
  | { type: 'clearSearch' }
  /** Fold or unfold every environment at once. */
  | { type: 'collapseAll'; on: boolean }
  /** The editor moved; bring that row into view and select it. */
  | { type: 'reveal'; id: string };

export type SidebarWebviewMessage =
  | { type: 'ready' }
  | { type: 'select'; id: string }
  /** Open the connection editor on this row. */
  | { type: 'open'; id: string }
  | { type: 'connect'; id: string }
  | { type: 'disconnect'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'favourite'; id: string; on: boolean }
  /** The row's overflow button. The host answers with its own quick pick. */
  | { type: 'menu'; id: string }
  | { type: 'new' }
  /**
   * Whether anything is filtered, and how much survived. `matched` is here
   * because the query lives in the panel, so the host cannot count it, and
   * the view description has to be able to say "12 of 84" the way the tree's
   * own count label did.
   */
  | { type: 'filtered'; on: boolean; matched: number }
  | { type: 'grouped'; on: boolean }
  | { type: 'sort'; value: SortOrder }
  | { type: 'collapse'; environment: EnvironmentId; on: boolean };
