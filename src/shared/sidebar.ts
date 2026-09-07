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
import {
  CatalogSummary,
  ExplorerMode,
  FavouriteRef,
  MemberList,
  ObjectPage,
  ObjectPageRequest,
  SearchAnswer
} from './catalog';
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
  /**
   * How this connection arranges its children, and which of its objects are
   * pinned.
   *
   * Both are here rather than in a message of their own because both change the
   * *shape* of the tree, which is exactly what this projection is for: the
   * panel rebuilds its flattened index from `rows`, and a mode switch or a new
   * pin has to rebuild it. The volatile half of a row still lives on
   * `SessionUpdate`, and nothing about a session belongs here.
   */
  mode: ExplorerMode;
  pins: FavouriteRef[];
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
  | { type: 'reveal'; id: string }
  /*
   * The explorer's half of the contract.
   *
   * Every one of these carries the profile id and the node key the request was
   * made under, and the panel matches them before merging. A tree that expanded
   * three folders while a slow query was in flight must not pour that query's
   * five hundred rows into whichever folder happens to be open when it lands.
   */
  /** A connection's counts and schema list, or why they could not be read. */
  | { type: 'catalog'; profileId: string; summary: CatalogSummary }
  | { type: 'catalogError'; profileId: string; message: string }
  /** One folder's rows, cumulative: `objects` is the whole folder, not a page. */
  | ({ type: 'objects' } & ObjectPage)
  | ({ type: 'members' } & MemberList)
  | { type: 'nodeError'; profileId: string; node: string; message: string }
  /** Server-side matches, merged into whatever the panel already found. */
  | ({ type: 'searchAnswer' } & SearchAnswer)
  /**
   * The catalog for this connection is no longer valid — it disconnected, or
   * Refresh was used. An empty id means every connection.
   */
  | { type: 'catalogCleared'; profileId: string };

export type SidebarWebviewMessage =
  | { type: 'ready' }
  /** Open the connection editor on this row. */
  | { type: 'open'; id: string }
  | { type: 'connect'; id: string }
  | { type: 'disconnect'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'new' }
  /**
   * Whether anything is filtered, and how much survived. `matched` is here
   * because the query lives in the panel, so the host cannot count it, and
   * the view description has to be able to say "12 of 84" the way the tree's
   * own count label did.
   */
  | { type: 'filtered'; on: boolean; matched: number }
  | { type: 'collapse'; environment: EnvironmentId; on: boolean }
  /**
   * A connection was expanded and has no summary yet. Separate from `connect`
   * because expanding something already open must not re-authenticate, and
   * separate from `loadNode` because the counts are one query for the whole
   * connection rather than one per folder.
   */
  | { type: 'loadCatalog'; profileId: string }
  /** A folder was opened, or its `Load more` row was pressed. */
  | ({ type: 'loadNode' } & ObjectPageRequest)
  /** An object was expanded: its columns, or its parameters. */
  | { type: 'loadMembers'; profileId: string; node: string; ref: FavouriteRef }
  /**
   * Ask every open connection for matches. The panel has already matched what
   * it holds; this is for the rest of a database it has never read.
   */
  | { type: 'searchObjects'; query: string };
