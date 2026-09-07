import { memo } from 'react';
import { KINDS, ObjectKind } from '../../shared/catalog';
import { Codicon } from '../primitives/Codicon';
import { IconMark, ObjectIcon } from '../primitives/ObjectIcon';
import { post } from './api';
import { segments } from './host';
import { H } from './model';
import { cursorStore, loadMore, toggleExpanded, useIsCursor } from './state';

/**
 * Clicking a row makes it the cursor.
 *
 * The roving tabindex means only the cursor carries `tabindex="0"`, but every
 * other row is `-1` rather than absent, so a click focuses it in the DOM
 * regardless. Without this the two disagree: the clicked row has focus, the
 * cursor is still wherever it was, and the next arrow key moves from a row the
 * user is no longer looking at. The connection row has always done this; every
 * row inside one has to as well.
 */
function take(gkey: string): void {
  cursorStore.setState((s) => (s.cursorId === gkey ? s : { ...s, cursorId: gkey }));
}

/**
 * Tells the host which object the cursor is on, so the details panel can
 * follow it.
 *
 * A notification rather than a request: the tree does not change because of
 * it, and a window with the panel closed drops it on the floor. That is what
 * keeps the explorer from having to know the panel exists.
 */
function announce(profileId: string, kind: ObjectKind, schema: string, name: string): void {
  post({ type: 'selectObject', profileId, ref: { kind, schema, name } });
}

/**
 * Everything inside a connection: folders, schemas, objects, columns and the
 * four notes among them.
 *
 * All of them are 22px and all of them share one rail — twistie, mark, name,
 * and a right-hand column — so the tree reads as four vertical columns rather
 * than as a thousand rows of prose. That is the same argument the connection
 * row's rail is built on, one level down.
 *
 *   x = 8 + (level−1)×10 ── twistie 14 ── mark 16 ── name … ── right column
 *
 * The twistie is 14 and not 12 so that a heading's chevron, a connection's and
 * a folder's all land in one column; a leaf leaves the same 18px behind rather
 * than closing it up, because a chevron column that is only present on some
 * rows is not a column.
 *
 * The right column is the one design decision here worth defending. `Tables
 * 1240` and `dbo.Customer 34 columns` put their number in the same place, so
 * the counts and the shapes form a column the eye can run down without reading
 * a single label. Putting the count in brackets after the label, which is what
 * SSMS does, gives every row a different shape and destroys that scan.
 *
 * Every prop on every component here is a primitive, and that is not a style
 * preference: it is what lets `memo` bail on all thirty windowed rows when the
 * list scrolls by a pixel. The moment one of them takes an object or a
 * closure, the virtualizer is doing a full render per frame.
 */

interface Common {
  /** The global key: also the cursor id and the React key. */
  gkey: string;
  top: number;
  level: number;
  ariaLevel: number;
  posinset: number;
  setsize: number;
}

/* ----------------------------------------------------------------- folder */

export const FolderRow = memo(function FolderRow(
  props: Common & {
    label: string;
    count: number;
    mark: IconMark;
    expanded: boolean;
    /** Favourites is the one folder whose count of zero still means something. */
    alwaysCount: boolean;
  }
) {
  const { gkey, top, level, ariaLevel, posinset, setsize, label, count, mark, expanded } = props;
  const cursor = useIsCursor(gkey);

  return (
    <div
      className={`node node-folder${cursor ? ' is-cursor' : ''}`}
      role="treeitem"
      aria-level={ariaLevel}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-expanded={expanded}
      aria-label={`${label}, ${count.toLocaleString()}`}
      data-id={gkey}
      tabIndex={cursor ? 0 : -1}
      style={{ top, height: H.node, ['--lvl' as string]: level }}
      onClick={() => {
        take(gkey);
        toggleExpanded(gkey);
      }}
    >
      <Twistie expanded={expanded} />
      <ObjectIcon mark={mark} />
      <span className="node-name">{label}</span>
      {count > 0 || props.alwaysCount ? (
        <span className="node-tail num">{count.toLocaleString()}</span>
      ) : null}
    </div>
  );
});

/* ----------------------------------------------------------------- schema */

export const SchemaRow = memo(function SchemaRow(
  props: Common & { name: string; total: number; expanded: boolean; needle: string }
) {
  const { gkey, top, level, ariaLevel, posinset, setsize, name, total, expanded, needle } = props;
  const cursor = useIsCursor(gkey);

  return (
    <div
      className={`node node-schema${cursor ? ' is-cursor' : ''}`}
      role="treeitem"
      aria-level={ariaLevel}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-expanded={expanded}
      aria-label={`Schema ${name}, ${total.toLocaleString()} objects`}
      data-id={gkey}
      tabIndex={cursor ? 0 : -1}
      title={`${name} · ${total.toLocaleString()} objects`}
      style={{ top, height: H.node, ['--lvl' as string]: level }}
      onClick={() => {
        take(gkey);
        toggleExpanded(gkey);
      }}
    >
      <Twistie expanded={expanded} />
      {/* The same folder every kind folder draws. A schema is a place you open
          and so is Tables; what tells them apart is the indent and the name,
          which is how a file tree has always done it. */}
      <ObjectIcon mark="folder" />
      <span className="node-name">
        <Marked text={name} needle={needle} />
      </span>
      <span className="node-tail num">{total.toLocaleString()}</span>
    </div>
  );
});

/* ----------------------------------------------------------------- object */

export const ObjectRow = memo(function ObjectRow(
  props: Common & {
    profileId: string;
    objKind: ObjectKind;
    schema: string;
    name: string;
    detail: string;
    qualify: boolean;
    expandable: boolean;
    expanded: boolean;
    favourite: boolean;
    needle: string;
  }
) {
  const {
    gkey,
    top,
    level,
    ariaLevel,
    posinset,
    setsize,
    profileId,
    objKind,
    schema,
    name,
    detail,
    qualify,
    expandable,
    expanded,
    favourite,
    needle
  } = props;
  const cursor = useIsCursor(gkey);

  // A search result has no detail of its own — the count was never fetched —
  // so it says what kind it is instead, which is the fact a result list is
  // missing and a folder already supplied.
  const tail = detail || KINDS[objKind].singular;

  return (
    <div
      className={`node node-object k-${objKind}${cursor ? ' is-cursor' : ''}${favourite ? ' is-pinned' : ''}`}
      role="treeitem"
      aria-level={ariaLevel}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-expanded={expandable ? expanded : undefined}
      aria-label={`${KINDS[objKind].singular} ${schema}.${name}${tail ? `, ${tail}` : ''}${
        favourite ? ', pinned' : ''
      }`}
      data-id={gkey}
      tabIndex={cursor ? 0 : -1}
      title={`${schema}.${name}`}
      style={{ top, height: H.node, ['--lvl' as string]: level }}
      // The workbench draws the menu, not the page. The keys below are what the
      // `webview/context` `when` clauses read, which is what makes one row's
      // menu offer Select Top 100 and the next row's offer Execute.
      data-vscode-context={contextFor(profileId, objKind, schema, name, favourite)}
      onContextMenu={() => {
        take(gkey);
        announce(profileId, objKind, schema, name);
      }}
      onClick={() => {
        take(gkey);
        announce(profileId, objKind, schema, name);
        if (expandable) {
          toggleExpanded(gkey);
        }
      }}
    >
      {expandable ? <Twistie expanded={expanded} /> : <span className="twistie-gap" aria-hidden="true" />}
      <ObjectIcon mark={objKind} />
      <span className="node-name">
        {qualify ? (
          <span className="node-qual">
            <Marked text={schema} needle={needle} />.
          </span>
        ) : null}
        <Marked text={name} needle={needle} />
      </span>
      {favourite ? <ObjectIcon mark="favourite" size={11} className="node-pin" /> : null}
      <span className="node-tail">{tail}</span>
    </div>
  );
});

/* ----------------------------------------------------------------- member */

export const MemberRow = memo(function MemberRow(
  props: Common & { name: string; type: string; mark: IconMark; nullable: boolean }
) {
  const { gkey, top, level, ariaLevel, posinset, setsize, name, type, mark, nullable } = props;
  const cursor = useIsCursor(gkey);

  return (
    <div
      className={`node node-member m-${mark}${cursor ? ' is-cursor' : ''}`}
      role="treeitem"
      aria-level={ariaLevel}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-label={`${name}, ${type}${nullable ? ', nullable' : ', not null'}${
        mark === 'key' ? ', primary key' : mark === 'ref' ? ', foreign key' : ''
      }`}
      data-id={gkey}
      tabIndex={cursor ? 0 : -1}
      title={`${name} ${type}${nullable ? '' : ' NOT NULL'}`}
      style={{ top, height: H.node, ['--lvl' as string]: level }}
      onClick={() => take(gkey)}
    >
      <span className="twistie-gap" aria-hidden="true" />
      <ObjectIcon mark={mark} />
      <span className="node-name">{name}</span>
      {/* A dot for "may be null". It is the absence of the dot that carries the
          stronger fact, because NOT NULL is the constraint worth knowing, and
          the marks are the wrong way round for a reason: a column list is
          mostly nullable, and marking the majority would be noise. */}
      {nullable ? null : <span className="node-notnull" aria-hidden="true" />}
      <span className="node-tail mono">{type}</span>
    </div>
  );
});

/* ------------------------------------------------------------------ notes */

export const NoteRow = memo(function NoteRow(
  props: Common & {
    tone: 'loading' | 'empty' | 'error' | 'more';
    text: string;
    profileId: string;
    node: string;
    offset: number;
  }
) {
  const { gkey, top, level, ariaLevel, posinset, setsize, tone, text, profileId, node, offset } = props;
  const cursor = useIsCursor(gkey);
  const pressable = tone === 'more';

  return (
    <div
      className={`node node-note tone-${tone}${cursor ? ' is-cursor' : ''}`}
      role="treeitem"
      aria-level={ariaLevel}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-label={text}
      aria-busy={tone === 'loading' || undefined}
      data-id={gkey}
      tabIndex={cursor ? 0 : -1}
      title={tone === 'error' ? text : undefined}
      style={{ top, height: H.node, ['--lvl' as string]: level }}
      onClick={() => {
        take(gkey);
        if (pressable) {
          loadMore(profileId, node, offset);
        }
      }}
    >
      <span className="twistie-gap" aria-hidden="true" />
      <span className="node-note-glyph" aria-hidden="true">
        {tone === 'loading' ? (
          // Both, always. Reduced motion freezes `loading` into a static arc
          // claiming a movement it does not have, so the stylesheet swaps in
          // `sync` there rather than a media-query listener disagreeing with
          // CSS. The same pair the connection row uses.
          <span className="glyph-busy">
            <Codicon name="loading" spin />
            <Codicon name="sync" />
          </span>
        ) : tone === 'error' ? (
          <Codicon name="warning" />
        ) : tone === 'more' ? (
          <Codicon name="chevron-down" />
        ) : (
          <Codicon name="dash" />
        )}
      </span>
      <span className="node-name">{text}</span>
    </div>
  );
});

/* ---------------------------------------------------------- results header */

/**
 * A search's per-connection heading.
 *
 * It is a section header rather than a row, so it sticks the way an
 * environment heading does: forty results deep into a four-connection search,
 * the connection the rows belong to is still on screen. Without that, a result
 * list across several servers is a list of names with no idea which database
 * each one is in — which for `dbo.Customer`, present on all four, is the one
 * fact that matters.
 */
export const ResultsHeader = memo(function ResultsHeader(props: {
  gkey: string;
  top: number;
  label: string;
  count: number;
  capped: boolean;
  posinset: number;
  setsize: number;
  overlay?: boolean;
}) {
  const { gkey, top, label, count, capped, posinset, setsize, overlay } = props;
  const cursor = useIsCursor(gkey);

  return (
    <div
      className="head head-results"
      role="treeitem"
      aria-level={1}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-label={`${label}, ${count} matching objects${capped ? ', showing the closest' : ''}`}
      data-id={gkey}
      tabIndex={!overlay && cursor ? 0 : -1}
      style={{ top, height: H.results }}
      onClick={overlay ? undefined : () => take(gkey)}
    >
      <span className="twistie" aria-hidden="true">
        <Codicon name="search" />
      </span>
      <span className="head-badge head-results-name">{label}</span>
      <span className="head-count">{capped ? `${count}+` : count}</span>
    </div>
  );
});

/* ---------------------------------------------------------------- pieces */

function Twistie({ expanded }: { expanded: boolean }) {
  return (
    <span className={`twistie twistie-node${expanded ? '' : ' is-collapsed'}`} aria-hidden="true">
      <Codicon name="chevron-down" />
    </span>
  );
}

/**
 * The needle arrives already trimmed and lower-cased, the way `parseQuery`
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
 * `objectKind` is in here rather than looked up host-side because the menu is
 * built from `when` clauses before any command runs — it is what lets a table
 * offer Select Top 100 and Generate CRUD while a procedure offers Execute and
 * Script As ALTER, from one contributed menu.
 */
function contextFor(
  profileId: string,
  kind: ObjectKind,
  schema: string,
  name: string,
  favourite: boolean
): string {
  return JSON.stringify({
    webviewSection: 'dbObject',
    connectionId: profileId,
    objectKind: kind,
    objectSchema: schema,
    objectName: name,
    dbObjectPinned: favourite,
    // `dbObjectRelational` collapses "a thing you can select rows from" into
    // one key, so the two menu items that share that condition are not two
    // `when` clauses that have to be kept in step with each other.
    dbObjectRelational: kind === 'table' || kind === 'view',
    dbObjectRoutine: kind === 'procedure' || kind === 'function',
    preventDefaultContextMenuItems: true
  });
}
