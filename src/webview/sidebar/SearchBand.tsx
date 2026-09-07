import { KeyboardEvent, MutableRefObject, useEffect, useMemo, useState } from 'react';
import { SidebarHostMessage } from '../../shared/sidebar';
import { Codicon } from '../primitives/Codicon';
import { useStoreSelector } from '../state/store';
import { post } from './api';
import { matchRow } from './model';
import { ListState, listStore } from './state';

const selRows = (s: ListState) => s.rows;
const selQuery = (s: ListState) => s.query;

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

  // Typing must not produce a stream of interruptions, so the count is
  // announced when the typing stops rather than on every keystroke.
  useEffect(() => {
    if (!needle) {
      setAnnounce('');
      return;
    }
    const id = window.setTimeout(
      () => setAnnounce(`${matched} of ${rows.length} connections match`),
      500
    );
    return () => window.clearTimeout(id);
  }, [needle, matched, rows.length]);

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
        placeholder="Name, host, database"
        aria-label="Search connections by name, host or database"
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
