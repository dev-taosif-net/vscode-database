import { Codicon } from '../primitives/Codicon';
import { post } from './api';
import { H } from './model';
import { listStore, useIsCursor } from './state';

/**
 * Parity, not polish.
 *
 * `contributes.viewsWelcome` only applies to tree views, so the moment this
 * view became a webview that contribution stopped rendering and it was deleted
 * from the manifest. Nothing about `package.json` looks wrong afterwards, which
 * is exactly why a user with no profiles would otherwise get a blank panel and
 * nobody would notice. The copy below is that contribution's copy, verbatim.
 *
 * The button is full width because `editor.css`'s `.engine-card` is 272px and
 * does not fit a 170px sidebar, so none of it is reused.
 */
export function EmptyState(): JSX.Element {
  return (
    <div className="empty">
      <Codicon name="database" />
      <h2>No connections yet.</h2>
      <p>
        SQL Server and PostgreSQL. Profiles are kept per user, and credentials go to the operating
        system keychain.
      </p>
      <button type="button" onClick={() => post({ type: 'new' })}>
        New connection
      </button>
    </div>
  );
}

interface NoMatchProps {
  query: string;
  top: number;
}

/** The cursor id for the card, following the convention the headers use. */
export const NOMATCH_ID = 'nomatch';

/**
 * An empty scroller would read as "there is nothing here". There is; it is
 * filtered out, and saying so is the whole difference. It is a real item in
 * the flattened list, so it is a real tree item with a real position, and it
 * takes the roving tabindex like anything else the cursor can land on — when it
 * is showing it is the only thing in the tree, so there is nothing else to hold
 * it.
 *
 * It says "Nothing matches" rather than "No connection matches", because since
 * phase 2 the same query is run against every open connection's objects as
 * well, and a card that named only connections would be claiming the search was
 * narrower than it was.
 */
export function NoMatch({ query, top }: NoMatchProps): JSX.Element {
  const cursor = useIsCursor(NOMATCH_ID);

  return (
    <div
      className="nomatch"
      style={{ top, height: H.nomatch }}
      role="treeitem"
      aria-level={1}
      aria-posinset={1}
      aria-setsize={1}
      tabIndex={cursor ? 0 : -1}
    >
      <Codicon name="info" />
      <p>Nothing matches “{query}”</p>
      <button
        type="button"
        onClick={() => listStore.setState((s) => (s.query === '' ? s : { ...s, query: '' }))}
      >
        Clear the search
      </button>
    </div>
  );
}
