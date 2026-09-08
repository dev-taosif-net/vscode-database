import { EnvironmentId, environmentLabel, environmentMeta } from '../../types';
import { Codicon } from '../primitives/Codicon';
import { H } from './model';
import { fold, useIsCursor } from './state';

/**
 * The ids the cursor uses for the two kinds of section header.
 *
 * `environment:qa` is the id `EnvironmentTreeItem` already gave its headings,
 * kept because a second convention for the same thing is a second thing to get
 * wrong. A profile id is a uuid, so neither of these can collide with a row.
 */
const PINNED_ID = 'pinned';

function headerId(environment: EnvironmentId): string {
  return `environment:${environment}`;
}

/**
 * An environment heading: 24px, folded or not.
 *
 * It once grew to 40px when folded, to spend the freed pixels on
 * `ENVIRONMENTS[].guard`, and it once spelled the environment out beside the
 * badge. Both are the connection editor's to say, at the moment they apply,
 * so the heading is the badge and the count and nothing else, and folding
 * moves nothing but rows.
 *
 * `ENVIRONMENTS[].full` did not leave with the text. It is still the twistie's
 * accessible name, and dropping a word from the screen is not a reason to drop
 * it from the one place it is read aloud.
 *
 * The open count is a prop rather than a subscription. It comes down on the
 * `FlatItem`, so a session opening re-renders the headers through their parent
 * and this component reads no store but the cursor.
 */
export function GroupHeader(props: {
  environment: EnvironmentId;
  count: number;
  open: number;
  collapsed: boolean;
  top: number;
  posinset: number;
  setsize: number;
  overlay?: boolean;
}): JSX.Element {
  const { environment, count, open, collapsed, top, posinset, setsize, overlay } = props;
  const meta = environmentMeta(environment);
  const cursor = useIsCursor(headerId(environment));

  // The overlay copy toggles through the same call with the same arguments, so
  // "proxy to the real header's handler" needs no shared closure and no ref
  // between the two: the handler is a pure function of the props both copies
  // are given. It goes through `fold` rather than posting on its own, because
  // the host persists the fold without answering, so a twistie that only posted
  // changed its own glyph and left every row where it was.
  const toggle = () => fold(environment, !collapsed);
  const action = collapsed ? `Expand ${meta.full}` : `Collapse ${meta.full}`;

  return (
    <div
      className={`head env-${environment}${collapsed ? ' is-collapsed' : ''}`}
      role="treeitem"
      aria-level={1}
      aria-expanded={!collapsed}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-label={groupName(environment, count, open)}
      data-id={headerId(environment)}
      // The overlay is aria-hidden and sits on top of the real header, so it
      // must never become the tab stop the real one already is.
      tabIndex={!overlay && cursor ? 0 : -1}
      style={{ top, height: H.group }}
      onClick={toggle}
    >
      <button
        type="button"
        className="twistie"
        tabIndex={-1}
        aria-expanded={!collapsed}
        aria-label={action}
        title={action}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} />
      </button>
      {/*
        The slot is always here and only production draws in it.

        A disc in the environment's own hue, four pixels from a badge in the
        same hue, four pixels from a ribbon in the same hue, is the third mark
        in forty pixels saying one word — and it is the word already spelled
        out beside it. Production keeps its shield because production is the
        one heading where a fourth signal is worth its ink.

        The slot survives the discs because the badge is a column: 16 + 5 puts
        it at x=47, the same left edge as the name on every row below it. An
        empty span is what keeps that edge true on three headings out of four.
      */}
      <span className="head-glyph" aria-hidden="true">
        {environment === 'prod' ? <Codicon name="shield" /> : null}
      </span>
      <span className="head-badge">{meta.short}</span>
      <span className="head-count">{countText(count, open)}</span>
    </div>
  );
}

/**
 * The favourites heading. It has no ribbon of its own on purpose: its rows keep
 * theirs, so the 3px column beside this section is multicoloured while every
 * environment group's is a single hue. That texture is how you tell the pinned
 * section from a group at a glance, at any width, with no icon and no reading.
 *
 * There is no twistie button because the section does not fold — `collapsed` is
 * typed `EnvironmentId[]` and there is no id for this, and a handful of rows
 * that are deliberately the first thing you see do not need hiding. The chevron
 * is drawn anyway, because the glyph column has to line up with the group
 * headings above and below it.
 */
export function PinnedHeader(props: {
  count: number;
  top: number;
  posinset: number;
  setsize: number;
  overlay?: boolean;
}): JSX.Element {
  const { count, top, posinset, setsize, overlay } = props;
  const cursor = useIsCursor(PINNED_ID);

  return (
    <div
      className="head"
      role="treeitem"
      aria-level={1}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-label={`Pinned, ${count === 1 ? '1 connection' : `${count} connections`}`}
      data-id={PINNED_ID}
      tabIndex={!overlay && cursor ? 0 : -1}
      style={{ top, height: H.pinned }}
    >
      <span className="twistie" aria-hidden="true">
        <Codicon name="chevron-down" />
      </span>
      <span className="head-glyph" aria-hidden="true">
        <Codicon name="pinned" />
      </span>
      <span className="head-badge">PINNED</span>
      <span className="head-count">{count}</span>
    </div>
  );
}

/** `18` on its own, `18 · 2 open` once something in the group is live. */
function countText(count: number, open: number): string {
  return open > 0 ? `${count} · ${open} open` : String(count);
}

function groupName(environment: EnvironmentId, count: number, open: number): string {
  const connections = count === 1 ? '1 connection' : `${count} connections`;
  return `${environmentLabel(environment)}, ${connections}${open > 0 ? `, ${open} open` : ''}`;
}
