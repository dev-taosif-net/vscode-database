import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { SessionUpdate, SidebarHostMessage } from '../../shared/sidebar';
import { ENVIRONMENTS } from '../../types';
import { useStoreSelector } from '../state/store';
import { post, readPersisted, writePersisted } from './api';
import { EmptyState } from './EmptyState';
import { Footer } from './Footer';
import { SearchBand } from './SearchBand';
import { ListHandle, VirtualList } from './VirtualList';
import { ListState, cursorStore, fold, index, listStore, sessionStore } from './state';

const selReady = (s: ListState) => s.ready;
const selCount = (s: ListState) => s.rows.length;
const selQuery = (s: ListState) => s.query;

export function Sidebar(): JSX.Element {
  const ready = useStoreSelector(listStore, selReady);
  const count = useStoreSelector(listStore, selCount);
  const query = useStoreSelector(listStore, selQuery);

  const list = useRef<ListHandle | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const persistAt = useRef(0);
  const persistTop = useRef(0);

  const [initialTop] = useState(() => readPersisted().scrollTop ?? 0);

  useEffect(() => {
    const onMessage = (event: MessageEvent<SidebarHostMessage>): void => {
      const message = event.data;
      switch (message.type) {
        case 'state': {
          const byId = index(message.rows);
          const previous = listStore.getState().byId;
          // The query is the panel's own and survives every state message; a
          // filter that cleared itself whenever a session opened would be
          // unusable at two hundred rows.
          listStore.setState((s) => ({
            ...s,
            rows: message.rows,
            byId,
            grouped: message.grouped,
            sort: message.sort,
            collapsed: message.collapsed,
            ready: true
          }));
          cursorStore.setState((s) => ({
            selectedId: message.selectedId,
            // A cursor left on a profile that has just been deleted would keep
            // a dead row mounted for ever, because the cursor is always
            // rendered. Comparing the two maps rather than the shape of the id
            // means the section headers' own cursor ids need no exemption.
            cursorId:
              s.cursorId !== null && previous[s.cursorId] && !byId[s.cursorId] ? null : s.cursorId
          }));
          return;
        }

        case 'sessions': {
          const map: Record<string, SessionUpdate> = {};
          for (const update of message.active) {
            map[update.id] = update;
          }
          sessionStore.setState(() => map);
          return;
        }

        case 'collapseAll': {
          // The host sent this, so the host already knows; echoing a collapse
          // back for every environment would be four writes to answer one.
          const next = message.on ? ENVIRONMENTS.map((e) => e.id) : [];
          listStore.setState((s) => ({ ...s, collapsed: next }));
          return;
        }

        case 'reveal':
          list.current?.reveal(message.id);
          return;

        default:
          // `focusSearch` and `clearSearch` belong to the box that owns the
          // text, and it listens for them itself.
          return;
      }
    };

    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /**
   * After a host round trip — a quick pick, a modal confirmation — the webview
   * regains focus with nothing focused inside it, and the browser would leave
   * it on the body. Anything already focused is left alone, so this never
   * steals the search box back.
   */
  useEffect(() => {
    const onFocus = (): void => {
      if (document.activeElement === document.body) {
        list.current?.restoreFocus();
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(
    () => () => {
      if (persistAt.current) {
        window.clearTimeout(persistAt.current);
      }
    },
    []
  );

  /** One memento write per quarter second, whatever the scroll wheel does. */
  const onTop = useCallback((top: number) => {
    persistTop.current = top;
    if (persistAt.current) {
      return;
    }
    persistAt.current = window.setTimeout(() => {
      persistAt.current = 0;
      writePersisted({ scrollTop: persistTop.current });
    }, 250);
  }, []);

  const focusSearch = (selectAll: boolean): void => {
    const el = search.current;
    if (!el) {
      return;
    }
    el.focus();
    if (selectAll) {
      el.select();
    }
  };

  const onLeaveSearch = useCallback((where: 'first' | 'firstRow' | 'cursor') => {
    const handle = list.current;
    if (!handle) {
      return;
    }
    if (where === 'cursor') {
      handle.restoreFocus();
    } else {
      handle.focusFirst(where === 'firstRow');
    }
  }, []);

  const onReveal = useCallback((id: string) => list.current?.reveal(id), []);

  /**
   * The whole keyboard model, in one table.
   *
   * It is bound to the panel rather than to each row because a virtualized row
   * can be unmounted between keydown and keyup, and because the last rule —
   * any printable character goes to the search box — has to fire from a header
   * as well as from a row.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target instanceof HTMLElement ? event.target : null;

    if ((event.key === 'f' || event.key === 'F') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      focusSearch(true);
      return;
    }

    if (!target || !target.closest('.list')) {
      return;
    }

    const handle = list.current;
    if (!handle) {
      return;
    }
    const items = handle.items();
    const n = items.length;
    if (n === 0) {
      return;
    }

    const at = handle.cursorIndex();
    // Nothing has been touched yet, so every navigation key lands on the first
    // item rather than stepping off an imaginary one.
    const landing = at < 0;
    const i = landing ? 0 : at;
    const item = items[i];
    const header = item.kind === 'group' || item.kind === 'pinned';

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        handle.focusIndex(landing ? 0 : Math.min(n - 1, i + 1));
        return;

      case 'ArrowUp':
        event.preventDefault();
        handle.focusIndex(landing ? 0 : Math.max(0, i - 1));
        return;

      case 'Home':
        event.preventDefault();
        handle.focusIndex(0);
        return;

      case 'End':
        event.preventDefault();
        handle.focusIndex(n - 1);
        return;

      case 'PageDown':
        event.preventDefault();
        handle.focusIndex(Math.min(n - 1, i + handle.page()));
        return;

      case 'PageUp':
        event.preventDefault();
        handle.focusIndex(Math.max(0, i - handle.page()));
        return;

      case 'ArrowLeft': {
        event.preventDefault();
        if (item.kind === 'group' && !item.collapsed) {
          fold(item.environment, true);
          return;
        }
        if (header) {
          for (let k = i - 1; k >= 0; k--) {
            if (items[k].kind === 'group' || items[k].kind === 'pinned') {
              handle.focusIndex(k);
              return;
            }
          }
          return;
        }
        const owner = handle.ownerOf(i);
        if (owner >= 0) {
          handle.focusIndex(owner);
        }
        return;
      }

      case 'ArrowRight':
        event.preventDefault();
        if (item.kind === 'group' && item.collapsed) {
          fold(item.environment, false);
          return;
        }
        if (header && i + 1 < n && items[i + 1].kind === 'row') {
          handle.focusIndex(i + 1);
        }
        return;

      case 'Enter':
        if (target.closest('.rail')) {
          return;
        }
        event.preventDefault();
        if (item.kind === 'group') {
          fold(item.environment, !item.collapsed);
        } else if (item.kind === 'row') {
          post({ type: 'open', id: item.id });
        }
        return;

      case ' ':
        if (target.closest('.rail')) {
          return;
        }
        event.preventDefault();
        if (item.kind === 'group') {
          fold(item.environment, !item.collapsed);
          return;
        }
        if (item.kind === 'row') {
          // The one gesture whose meaning depends on the row: an attempt in
          // flight is cancelled, an open session is closed, everything else is
          // opened.
          const state = sessionStore.getState()[item.id]?.state;
          if (state === 'connected') {
            post({ type: 'disconnect', id: item.id });
          } else if (state === 'connecting' || state === 'testing') {
            post({ type: 'cancel', id: item.id });
          } else {
            post({ type: 'connect', id: item.id });
          }
        }
        return;

      case 'Delete':
        if (item.kind === 'row') {
          event.preventDefault();
          post({ type: 'delete', id: item.id });
        }
        return;

      case 'ContextMenu':
        if (item.kind === 'row') {
          event.preventDefault();
          post({ type: 'menu', id: item.id });
        }
        return;

      case 'F10':
        if (event.shiftKey && item.kind === 'row') {
          event.preventDefault();
          post({ type: 'menu', id: item.id });
        }
        return;

      case '*': {
        event.preventDefault();
        const was = listStore.getState().collapsed;
        if (was.length === 0) {
          return;
        }
        listStore.setState((s) => ({ ...s, collapsed: [] }));
        for (const environment of was) {
          post({ type: 'collapse', environment, on: false });
        }
        return;
      }

      default:
        break;
    }

    /**
     * This replaces the workbench's type-ahead rather than reimplementing it.
     * There is a real search box on screen and two competing find mechanisms in
     * one list is worse than one — and the box matches the host and the database
     * where type-ahead would only match a prefix of the name.
     */
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const next = listStore.getState().query + event.key;
      listStore.setState((s) => ({ ...s, query: next }));
      focusSearch(false);
      // The box is controlled, so its value arrives on the next commit; a caret
      // left at zero would put the second character in front of the first.
      const el = search.current;
      if (el) {
        requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
      }
    }
  };

  const empty = ready && count === 0 && query.trim() === '';

  return (
    <div className="sidebar" onKeyDown={onKeyDown}>
      <SearchBand inputRef={search} onLeave={onLeaveSearch} />
      {empty ? (
        <EmptyState />
      ) : (
        <VirtualList handle={list} initialTop={initialTop} onTop={onTop} />
      )}
      <Footer onReveal={onReveal} />
    </div>
  );
}
