import { memo } from 'react';
import { ConnectionRow, ConnectionState } from '../../shared/sidebar';
import { environmentLabel, environmentMeta } from '../../types';
import { Codicon } from '../primitives/Codicon';
import { EngineMark } from '../primitives/EngineMark';
import { post } from './api';
import { fullHost, segments, splitHost } from './host';
import { H } from './model';
import { cursorStore, useIsCursor, useIsSelected, useRow, useSession } from './state';

/**
 * One connection, 22px, at every width and in every state.
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
}) {
  const { id, top, pinned, showBadge, level, posinset, setsize, needle, hit } = props;
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

  return (
    <div
      className={classes.join(' ')}
      role="treeitem"
      aria-level={level}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-selected={selected}
      aria-busy={flight || undefined}
      aria-label={accessibleName(row, state, session?.failure)}
      data-id={id}
      data-hit={hit}
      // Right-click is answered by the workbench, not by the page. A menu
      // drawn inside the webview cannot escape the panel's bounds and would be
      // clipped by the sidebar at every width that matters; this one is a real
      // workbench menu, positioned, themed and keyboard-driven by VS Code. The
      // two `dbConnection` keys are read by the `webview/context` `when`
      // clauses in the manifest, which is what makes one entry say Connect and
      // the next row's say Disconnect.
      data-vscode-context={contextFor(id, state, pinned)}
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
        // The tree this replaced opened the editor on a single click, and the
        // keyboard model opens it on Enter, so the two paths stay identical.
        post({ type: 'open', id });
      }}
    >
      <StateGlyph state={state} readOnly={row.readOnly} />
      <span className="engine" aria-hidden="true">
        <EngineMark driver={row.driver} size={16} />
      </span>
      <NameRun row={row} label={label} showBadge={showBadge} needle={needle} />
      <StateBadge state={state} />
    </div>
  );
});

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
 * The elastic run: badge, name, host, database.
 *
 * Every field is in the DOM on every row at every width, and the stylesheet
 * alone decides what is visible. Dropping a field in JavaScript when it will
 * not fit is what destroys the vertical column scan the list is read by — a
 * field present on some rows and absent on others makes the eye read a hundred
 * rows of prose instead of four columns.
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

  return (
    <span className="run">
      {/* A pinned or flat row has no header above it saying where it lives,
          so it carries the environment itself — the rule the tree already
          applied when grouping was off. */}
      {showBadge ? <span className="env-badge">{environmentMeta(row.environment).short}</span> : null}
      <span className="name">
        <Marked text={label} needle={needle} />
      </span>
      <span className="sep" aria-hidden="true" />
      <span className="host mono">
        <span className="host-head">
          <Marked text={parts.head} needle={needle} />
        </span>
        <span className="host-tail">
          <Marked text={parts.tail} needle={needle} />
        </span>
        <span className="host-port">{parts.port}</span>
      </span>
      <span className="sep" aria-hidden="true" />
      <span className="db">
        <Marked text={row.database} needle={needle} />
      </span>
    </span>
  );
}

/**
 * Saved carries no badge, and that is an encoding rather than an omission.
 * Seventy-eight of eighty-four rows are saved; eighty-four badges of which
 * seventy-eight say the same word is 38px of ink per row competing with the
 * name and telling you nothing. The absence reads only because the other three
 * states reliably produce a mark.
 */
function StateBadge({ state }: { state: ConnectionState }) {
  if (state === 'connected') {
    return <span className="badge badge-live">LIVE</span>;
  }
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
function contextFor(id: string, state: ConnectionState, pinned: boolean): string {
  return JSON.stringify({
    webviewSection: 'connection',
    connectionId: id,
    dbConnectionLive: state === 'connected',
    dbConnectionPinned: pinned,
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
