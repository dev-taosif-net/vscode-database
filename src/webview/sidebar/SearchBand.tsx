import { KeyboardEvent, MutableRefObject, useEffect, useMemo, useState } from 'react';
import { SidebarHostMessage } from '../../shared/sidebar';
import { Codicon } from '../primitives/Codicon';
import { useStoreSelector } from '../state/store';
import { post } from './api';
import { matchRow } from './model';
import { ListState, hitsStore, listStore, searchObjects } from './state';

const selRows = (s: ListState) => s.rows;
const selQuery = (s: ListState) => s.query;
const selHits = (n: number) => n;

function setQuery(value: string): void {
  listStore.setState((s) => (s.query === value ? s : { ...s, query: value }));
}

interface Props {
  inputRef: MutableRefObject<HTMLInputElement | null>;
  /** Hand focus back to the tree: the first item, the first match, or the cursor. */
  onLeave: (where: 'first' | 'firstRow' | 'cursor') => void;
}

/**
 * The search band never scrolls and is the first thing the webview draws.
 *
 * The text lives here rather than on the host: a filter that round-trips on
 * every keystroke is a filter that stutters at two hundred rows. What the host
 * is told is the result, debounced — it needs the count to write "12 of 84"
 * into the view description, and it cannot count what it cannot see.
 */
export function SearchBand({ inputRef, onLeave }: Props): JSX.Element {
  const rows = useStoreSelector(listStore, selRows);
  const query = useStoreSelector(listStore, selQuery);
  const objectHits = useStoreSelector(hitsStore, selHits);
  const [announce, setAnnounce] = useState('');

  const needle = query.trim().toLowerCase();
  const matched = useMemo(
    () => (needle ? rows.reduce((n, row) => (matchRow(row, needle) ? n + 1 : n), 0) : rows.length),
    [rows, needle]
  );

  useEffect(() => {
    const id = window.setTimeout(() => post({ type: 'filtered', on: needle.length > 0, matched }), 200);
    return () => window.clearTimeout(id);
  }, [needle, matched]);

  /**
   * The server-side half of the search, on a longer fuse than the local half.
   *
   * The panel has already matched everything it holds by the time this fires —
   * that is what makes the first keystroke feel instant — and this is only for
   * the objects it has never read. 250ms rather than 200 because every one of
   * these is a query against every open connection, and the cost of firing one
   * early is a round trip nobody waits for, on a database somebody else is
   * also using. The raw query is sent rather than the parsed needle, so the
   * answer can be matched against the query it answers and a late one dropped.
   */
  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) {
      return;
    }
    const id = window.setTimeout(() => searchObjects(value), 250);
    return () => window.clearTimeout(id);
  }, [query]);

  // Typing must not produce a stream of interruptions, so the count is
  // announced when the typing stops rather than on every keystroke.
  useEffect(() => {
    if (!needle) {
      setAnnounce('');
      return;
    }
    const id = window.setTimeout(() => {
      const connections = `${matched} of ${rows.length} connections match`;
      setAnnounce(
        objectHits > 0
          ? `${connections}, and ${objectHits} database ${objectHits === 1 ? 'object' : 'objects'}`
          : connections
      );
    }, 500);
    return () => window.clearTimeout(id);
  }, [needle, matched, rows.length, objectHits]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<SidebarHostMessage>): void => {
      if (event.data.type === 'focusSearch') {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (event.data.type === 'clearSearch') {
        setQuery('');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inputRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      // Deliberately without clearing: you search, you step into the results.
      event.preventDefault();
      onLeave('first');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onLeave('firstRow');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
      onLeave('cursor');
    }
  };

  return (
    <search className="search">
      <Codicon name="search" className="search-icon" />
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        value={query}
        placeholder="Search connections and objects…"
        aria-label="Search connections and database objects by name, schema or type"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {query !== '' && (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear the search"
          onClick={() => {
            setQuery('');
            inputRef.current?.focus();
          }}
        >
          <Codicon name="close" />
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </search>
  );
}
