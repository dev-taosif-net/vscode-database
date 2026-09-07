import { memo } from 'react';
import { ConnectionRow, ConnectionState } from '../../shared/sidebar';
import { environmentLabel, environmentMeta } from '../../types';
import { Codicon } from '../primitives/Codicon';
import { EngineMark } from '../primitives/EngineMark';
import { post } from './api';
import { fullHost, segments, splitHost } from './host';
import { H } from './model';
import {
  connectionKey,
  cursorStore,
  toggleExpanded,
  useIsCursor,
  useIsSelected,
  useRow,
  useSession
} from './state';

/**
 * One connection, 22px, one line, at every width and in every state.
 *
 * The second line has gone. It carried the host and the database on every row,
 * which is exactly what the footer readout carries in full for the row the
 * cursor is on, so the panel was paying twelve pixels a row to repeat a strip
 * it already draws. In a 560px sidebar that is the difference between thirteen
 * connections and twenty.
 *
 * The rail lost a slot as well. The engine mark sat between the state glyph
 * and the name — the position the eye lands on — answering a question nobody
 * scanning a list is asking, in a full-colour gradient at 16px. It is now the
 * last thing on the row, where a column of engine marks is still scannable and
 * competes with nothing. That leaves three slots before the name instead of
 * five and puts it at x=47, which is also what repairs the indent: a folder
 * inside this connection starts at 57, one `--indent` to the right, where
 * before it started at 57 against a parent at 70 and the tree stepped
 * backwards at its first level.
 *
 * Every prop here is a primitive and every one of them is stable for the life
 * of the row, which is the whole point: scrolling by one pixel changes nothing
 * a `Row` receives, so `memo` bails on all thirty of them and a frame costs a
 * reconcile and no render. The moment a prop becomes an object — a `FlatItem`,
 * a handler closure, a match array — that bail stops firing and the list is a
 * hand-rolled virtualizer with none of the benefit.
 *
 * The row reads its own data through the four hooks in `state.ts` and through
 * nothing else. Those hooks hold their selectors stable; an inline arrow into
 * `useStoreSelector` resubscribes on every render, which across a window of
 * thirty rows is sixty `Set` mutations a frame that never throw and never warn.
 */
export const Row = memo(function Row(props: {
  id: string;
  top: number;
  pinned: boolean;
  showBadge: boolean;
  level: number;
  posinset: number;
  setsize: number;
  needle: string;
  /** The `data-hit` attribute value: a space-separated subset of "name host database". */
  hit: string;
  /** True once there is a session to read a catalogue through. */
  expandable: boolean;
  expanded: boolean;
  /** Whether this connection browses by schema. Read by the context menu. */
  schemaMode: boolean;
}) {
  const { id, top, pinned, showBadge, level, posinset, setsize, needle, hit } = props;
  const { expandable, expanded, schemaMode } = props;
  const row = useRow(id);
  const session = useSession(id);
  const cursor = useIsCursor(id);
  const selected = useIsSelected(id);

  // A delete lands on `listStore` before the parent's geometry is rebuilt, so
  // for one commit a windowed row can outlive the profile it names. Drawing
  // nothing is right: the next commit removes the element entirely.
  if (!row) {
    return <></>;
  }

  const state: ConnectionState = session?.state ?? 'saved';
  const flight = state === 'connecting' || state === 'testing';
  const label = row.name || row.host || 'Untitled connection';

  const classes = ['row', `env-${row.environment}`];
  if (state === 'connected') {
    classes.push('is-live');
  }
  if (state === 'failed') {
    classes.push('is-failed');
  }
  if (flight) {
    classes.push('is-busy');
  }
  if (pinned) {
    classes.push('is-pinned');
  }
  if (cursor) {
    classes.push('is-cursor');
  }
  if (selected) {
    classes.push('is-selected');
  }

  if (expandable) {
    classes.push('is-expandable');
  }

  return (
    <div
      className={classes.join(' ')}
      role="treeitem"
      aria-level={level}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-selected={selected}
      aria-expanded={expandable ? expanded : undefined}
      aria-busy={flight || undefined}
      aria-label={accessibleName(row, state, session?.failure)}
      data-id={id}
      data-hit={hit}
      // Right-click is answered by the workbench, not by the page. A menu
      // drawn inside the webview cannot escape the panel's bounds and would be
      // clipped by the sidebar at every width that matters; this one is a real
      // workbench menu, positioned, themed and keyboard-driven by VS Code. The
      // three `db*` keys are read by the `webview/context` `when` clauses in
      // the manifest, which is what makes one entry say Connect and the next
      // row's say Disconnect, and one say Enable Schema Focused Mode and the
      // next say Disable.
      data-vscode-context={contextFor(id, state, pinned, schemaMode)}
      // Roving tabindex: the cursor row is the tree's single tab stop and
      // every other item is -1, so Tab crosses the whole list in one press
      // the way a tree does. The row has no controls of its own to tab
      // through: every action on it is on the right-click menu.
      tabIndex={cursor ? 0 : -1}
      title={address(row)}
      style={{ top, height: H.row }}
      onContextMenu={() => {
        cursorStore.setState((s) => (s.cursorId === id ? s : { ...s, cursorId: id }));
      }}
      onClick={() => {
        cursorStore.setState((s) => (s.cursorId === id ? s : { ...s, cursorId: id }));
        /*
         * A connected row is a container and opens; a saved row is a leaf and
         * opens the editor, which is what it did before there was anything
         * inside it.
         *
         * This is the one phase-1 gesture phase 2 changes, and the change is
         * forced: a row that both expands and opens an editor on one click can
         * do neither predictably. Editing a connected connection moved to Edit
         * Connection on the right-click menu, which is where the explorer's own
         * specification put it.
         */
        if (expandable) {
          toggleExpanded(connectionKey(id));
        } else {
          post({ type: 'open', id });
        }
      }}
    >
      {/* Always drawn, hidden when there is nothing to open, so the chevron
          column lines up with the group headings above and the folders below.
          A twistie that appears only on connected rows would make the whole
          left rail jog by eighteen pixels as sessions come and go. */}
      <span
        className={`twistie twistie-node${expanded ? '' : ' is-collapsed'}${
          expandable ? '' : ' is-hidden'
        }`}
        aria-hidden="true"
      >
        <Codicon name="chevron-down" />
      </span>
      <StateGlyph state={state} readOnly={row.readOnly} />
      <NameRun row={row} label={label} showBadge={showBadge} needle={needle} />
      {/* The elastic gap. Everything after it is a fixed column against the
          right edge, so the actions can be positioned over that column without
          the row's own layout knowing they exist. */}
      <span className="pad" />
      <StateBadge state={state} />
      <span className="engine" aria-hidden="true">
        <EngineMark driver={row.driver} size={14} />
      </span>
      <RowActions id={id} state={state} />
    </div>
  );
});

/**
 * The three buttons that appear on the row under the pointer.
 *
 * Every action on a connection used to be on the right-click menu and nowhere
 * else, which is a discoverable-by-nobody design: the two things people do all
 * day — open a session and edit the profile — took a gesture you have to be
 * told about. These are the same two, plus the menu itself, in three positions
 * that do not move between states, so the first slot is always "the session
 * thing" whatever the session is currently doing.
 *
 * They are `aria-hidden` and never tab stops, and that is deliberate rather
 * than an oversight. The row is a `treeitem` under a roving tabindex, so a
 * focusable control inside it would put three extra stops between one row and
 * the next and break the tree's keyboard model. Nothing here is reachable only
 * by mouse: the context menu is a complete, keyboard-driven superset of it,
 * and the row's `aria-label` already announces state.
 */
function RowActions({ id, state }: { id: string; state: ConnectionState }) {
  const flight = state === 'connecting' || state === 'testing';

  return (
    <span className="acts" aria-hidden="true">
      {state === 'connected' ? (
        <Action icon="debug-disconnect" title="Disconnect" run={() => post({ type: 'disconnect', id })} />
      ) : flight ? (
        <Action icon="stop-circle" title="Cancel" run={() => post({ type: 'cancel', id })} />
      ) : (
        <Action icon="plug" title="Connect" run={() => post({ type: 'connect', id })} />
      )}
      <Action icon="edit" title="Edit Connection" run={() => post({ type: 'open', id })} />
      <Action icon="ellipsis" title="More Actions…" run={openMenu} />
    </span>
  );
}

function Action({ icon, title, run }: { icon: string; title: string; run: (el: HTMLElement) => void }) {
  return (
    <button
      type="button"
      className="act"
      tabIndex={-1}
      title={title}
      // The row's own click expands it or opens the editor. Neither is what
      // was asked for here, and a row that did both on one press would do
      // neither predictably.
      onClick={(event) => {
        event.stopPropagation();
        run(event.currentTarget);
      }}
    >
      <Codicon name={icon} />
    </button>
  );
}

/**
 * Reopens the row's own context menu under the button.
 *
 * There is no message for "show the menu" and there should not be: the menu is
 * built by the workbench from the `when` clauses in the manifest, out of the
 * `data-vscode-context` payload on the row this button sits in. Re-dispatching
 * a `contextmenu` event lets it bubble to that row and the workbench answers it
 * exactly as it answers a right-click, which is the point — one menu,
 * described in one place, with no second copy to drift.
 */
function openMenu(el: HTMLElement): void {
  const box = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: box.left, clientY: box.bottom })
  );
}

/**
 * Four silhouettes — disc, ring, triangle, arc — chosen to stay separable at
 * 12px with no colour at all. Print them in black and you can still name every
 * one; that is the test the whole state encoding has to pass.
 */
function StateGlyph({ state, readOnly }: { state: ConnectionState; readOnly: boolean }) {
  return (
    <span className="glyph" aria-hidden="true">
      {state === 'connected' ? (
        // The environment's own hue, never a green. A connected production row
        // has to read as production first and as connected second.
        <Codicon name="circle-filled" />
      ) : state === 'failed' ? (
        // Failure is the one state that gives up the environment hue, because
        // surrendering it is itself the signal.
        <Codicon name="warning" />
      ) : state === 'connecting' || state === 'testing' ? (
        // Both spinners, always. Reduced motion freezes `loading` into a static
        // arc claiming a motion it does not have, so the stylesheet swaps in
        // `sync` there rather than a media-query listener disagreeing with CSS.
        <span className="glyph-busy">
          <Codicon name="loading" spin />
          <Codicon name="sync" />
        </span>
      ) : (
        <Codicon name="circle-outline" />
      )}
      {readOnly ? <Codicon name="lock" className="lock" /> : null}
    </span>
  );
}

/**
 * The name, then the address it names, on one line.
 *
 * The name is 13px at full ink and shrinks last; the detail is 10.5px, dim, and
 * shrinks four times as fast, so pressure takes the address a character at a
 * time and never touches the name until the address is gone. Within the address
 * the order is unchanged from when it had a line of its own — the domain suffix
 * evaporates first, then the port, then the host truncates from whichever end
 * keeps the part that differs.
 *
 * Every field is still in the DOM on every row and the stylesheet still decides
 * what is visible, with one deliberate exception below.
 */
function NameRun({
  row,
  label,
  showBadge,
  needle
}: {
  row: ConnectionRow;
  label: string;
  showBadge: boolean;
  needle: string;
}) {
  const parts = splitHost(row);

  /*
   * The one field this component drops rather than styles away.
   *
   * A connection called PeopleDeskMatador pointing at a database called
   * PeopleDeskMatador spends a third of the row saying its own name twice, and
   * on a realistic estate that is most rows — the name is usually chosen from
   * the database. The rule against hiding fields in JavaScript is about the
   * vertical scan, and it holds for the columns the eye runs down: the rail,
   * the mark, the left edge of the name. This is trailing prose after the
   * name, and a repetition there is not a column, it is noise.
   */
  const database = row.database.toLowerCase() === label.toLowerCase() ? '' : row.database;

  return (
    <>
      {/* A pinned or flat row has no header above it saying where it lives, so
          it carries the environment itself — the rule the tree already applied
          when grouping was off. */}
      {showBadge ? <span className="env-badge">{environmentMeta(row.environment).short}</span> : null}
      <span className="name">
        <Marked text={label} needle={needle} />
      </span>
      <span className="detail">
        <span className="host mono">
          <span className="host-head">
            <Marked text={parts.head} needle={needle} />
          </span>
          <span className="host-tail">
            <Marked text={parts.tail} needle={needle} />
          </span>
          <span className="host-port">{parts.port}</span>
        </span>
        {database ? (
          <>
            <span className="sep" aria-hidden="true" />
            <span className="db">
              <Marked text={database} needle={needle} />
            </span>
          </>
        ) : null}
      </span>
    </>
  );
}

/**
 * Only the two states a glyph cannot finish the sentence for get a word.
 *
 * Saved never did, and the argument was always about arithmetic: on a
 * realistic estate seventy-eight of eighty-four rows are saved, and
 * seventy-eight badges saying the same thing is 38px of ink per row that tells
 * you nothing. Connected now joins it, because four other marks already say
 * connected. What is left is failure, which needs prose, and the two in-flight
 * kinds, which need to say which one is in flight — only one of them ends in a
 * session, and a row reporting the wrong one tells the user the opposite of
 * what is about to happen.
 */
function StateBadge({ state }: { state: ConnectionState }) {
  // Connected carries no word either, and for the same reason saved does not.
  // A filled disc, a bright tick over the group ribbon, a bolder name and a
  // chevron that now opens are four marks already saying it; LIVE was a fifth,
  // 38px wide, on every row anybody actually uses.
  if (state === 'failed') {
    return <span className="badge badge-fail">FAIL</span>;
  }
  // The spinner already says something is in flight; the word says which one,
  // and the two are kept apart here for the same reason the manager tracks the
  // kind at all. Only one of them ends in a session, so a connect that reported
  // itself as a test would be a row telling the user the opposite of what is
  // about to happen. They share a class because they look identical: it is the
  // busy style, and the word is the whole difference.
  if (state === 'connecting') {
    return <span className="badge badge-test">CONN</span>;
  }
  if (state === 'testing') {
    return <span className="badge badge-test">TEST</span>;
  }
  return null;
}

/**
 * The needle arrives already trimmed and lower-cased, the way `flatten`
 * normalises it, because `segments` compares it against a lower-cased copy of
 * the text and a stray capital would silently mark nothing.
 */
function Marked({ text, needle }: { text: string; needle: string }) {
  if (!needle || !text) {
    return <>{text}</>;
  }
  return (
    <>
      {segments(text, needle).map((run, i) => (run.hit ? <mark key={i}>{run.text}</mark> : run.text))}
    </>
  );
}

/**
 * The `data-vscode-context` payload, as the attribute wants it: a JSON string.
 *
 * `webviewSection` is what every `when` clause in the manifest keys off, and
 * `preventDefaultContextMenuItems` drops the webview's own Copy and Paste,
 * which mean nothing on a list row. The state has to be in here rather than
 * looked up host-side, because the menu is built from `when` clauses before any
 * command runs.
 */
function contextFor(
  id: string,
  state: ConnectionState,
  pinned: boolean,
  schemaMode: boolean
): string {
  return JSON.stringify({
    webviewSection: 'connection',
    connectionId: id,
    dbConnectionLive: state === 'connected',
    dbConnectionPinned: pinned,
    dbSchemaMode: schemaMode,
    preventDefaultContextMenuItems: true
  });
}

/** What the row draws when it has room, for the tooltip when it has not. */
function address(row: ConnectionRow): string {
  const parts = [fullHost(row), row.database || 'default database'];
  if (row.readOnly) {
    parts.push('Read-only');
  }
  return parts.join(' · ');
}

/**
 * Composed the way `ConnectionTreeItem.accessibilityInformation` composed it —
 * name, environment, state — so nothing a screen-reader user already relies on
 * changes wording, then extended with the fields the row visually elides at a
 * narrow width. The two in-flight kinds are kept apart because the manager now
 * distinguishes them, and a row that announces the wrong one is a row that lies.
 */
function accessibleName(row: ConnectionRow, state: ConnectionState, failure: string | undefined): string {
  const host = row.host || 'no host';
  const parts = [
    row.name || row.host || 'Untitled connection',
    environmentLabel(row.environment),
    stateWords(state, failure),
    row.driver === 'mssql' ? 'SQL Server' : 'PostgreSQL',
    row.port === null ? host : `${host} port ${row.port}`,
    row.database ? `database ${row.database}` : 'default database'
  ];
  if (row.readOnly) {
    parts.push('read-only');
  }
  return parts.join(', ');
}

function stateWords(state: ConnectionState, failure: string | undefined): string {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'testing':
      return 'testing';
    case 'failed':
      return failure ? `last attempt failed, ${failure}` : 'last attempt failed';
    case 'saved':
      return 'saved, not connected';
  }
}
