import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { SessionUpdate, SidebarHostMessage } from '../../shared/sidebar';
import { ENVIRONMENTS } from '../../types';
import { useStoreSelector } from '../state/store';
import { post, readPersisted, writePersisted } from './api';
import { EmptyState } from './EmptyState';
import { Footer } from './Footer';
import { SearchBand } from './SearchBand';
import { ListHandle, VirtualList } from './VirtualList';
import { FlatItem, expansionOf, isHeader, profileOfKey } from './model';
import {
  ListState,
  applyCatalogError,
  applyMembers,
  applyNodeError,
  applyObjects,
  applySearchAnswer,
  applySummary,
  clearCatalog,
  collapseTree,
  connectionKey,
  cursorStore,
  fold,
  index,
  listStore,
  loadMore,
  retry,
  sessionStore,
  setExpanded,
  toggleExpanded
} from './state';

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
          /*
           * A connection that has just gone live opens itself.
           *
           * Connecting is not a goal, it is a step towards looking at
           * something, and a tree that made you connect and then click the
           * chevron would be asking twice for one intention. It only fires on
           * the transition, so collapsing a connected connection by hand keeps
           * it collapsed.
           */
          const before = sessionStore.getState();
          for (const update of message.active) {
            if (update.state === 'connected' && before[update.id]?.state !== 'connected') {
              setExpanded(connectionKey(update.id), true);
            }
          }
          sessionStore.setState(() => map);
          return;
        }

        case 'collapseAll': {
          // The host sent this, so the host already knows; echoing a collapse
          // back for every environment would be four writes to answer one.
          const next = message.on ? ENVIRONMENTS.map((e) => e.id) : [];
          listStore.setState((s) => ({ ...s, collapsed: next }));
          if (message.on) {
            // Folding the environments without folding the trees inside them
            // would leave a hundred open folders waiting behind the chevrons.
            collapseTree();
          }
          return;
        }

        case 'reveal':
          list.current?.reveal(message.id);
          return;

        case 'catalog':
          applySummary(message.profileId, message.summary);
          return;

        case 'catalogError':
          applyCatalogError(message.profileId, message.message);
          return;

        case 'objects':
          applyObjects(message.profileId, message.node, message.objects, message.total);
          return;

        case 'members':
          applyMembers(message.profileId, message.node, message.members);
          return;

        case 'nodeError':
          applyNodeError(message.profileId, message.node, message.message);
          return;

        case 'searchAnswer':
          applySearchAnswer(message.profileId, message.query, message.objects, message.capped);
          return;

        case 'catalogCleared':
          clearCatalog(message.profileId);
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

  /**
   * Tells the host which connection the cursor is inside, so a command run
   * from the title bar knows what "this connection" means.
   *
   * Subscribed rather than posted from the rows, because the cursor moves from
   * five places — a click on a connection, a click on anything in its tree,
   * an arrow key, a reveal from the editor, and Enter out of the search box —
   * and four of them are nowhere near `Row`. One subscription on the store all
   * five already write to is the only version that cannot miss one.
   *
   * It posts on a change of connection and not on a change of cursor, so
   * walking twenty columns of one table is one message and not twenty.
   */
  useEffect(() => {
    let last: string | null = null;
    return cursorStore.subscribe(() => {
      const id = profileOfKey(cursorStore.getState().cursorId);
      if (id && id !== last) {
        last = id;
        post({ type: 'selectConnection', id });
      }
    });
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
   * The expansion key for an item, which is not its cursor id.
   *
   * A connection's cursor id is its profile id, because that is what `reveal`
   * and the editor's selection are addressed by; its subtree is opened under
   * `profileId + separator`, the same convention every node below it uses. The
   * two are deliberately different strings and this is the one place that
   * knows both.
   */
  const expansionKey = (item: FlatItem): string | null => {
    switch (item.kind) {
      case 'row':
        return item.expandable ? connectionKey(item.id) : null;
      case 'folder':
      case 'schema':
        return item.key;
      case 'object':
        return item.expandable ? item.key : null;
      default:
        return null;
    }
  };

  const open = (item: FlatItem): void => {
    const key = expansionKey(item);
    if (key) {
      setExpanded(key, true);
    }
  };

  const collapse = (item: FlatItem): void => {
    const key = expansionKey(item);
    if (key) {
      setExpanded(key, false);
    }
  };

  /** What Enter means, for every kind of thing the cursor can be on. */
  const activate = (item: FlatItem): void => {
    if (item.kind === 'group') {
      fold(item.environment, !item.collapsed);
      return;
    }
    if (item.kind === 'note') {
      if (item.tone === 'more') {
        loadMore(item.profileId, item.node, item.offset);
      } else if (item.tone === 'error') {
        retry(item.profileId, item.node);
      }
      return;
    }
    const key = expansionKey(item);
    if (key) {
      toggleExpanded(key);
      return;
    }
    if (item.kind === 'row') {
      // A saved connection is a leaf, and opening it means opening its editor.
      post({ type: 'open', id: item.id });
    }
  };

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
    const header = isHeader(item);

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

      /*
       * ← and → are the tree's own gesture and they now have five levels to
       * cross, so both go through `expansionOf` rather than through a chain of
       * `item.kind ===` tests. The rule is the workbench's: → opens what is
       * closed and steps in when it is already open, ← closes what is open and
       * steps out when it is already closed. Everything below is that rule and
       * the two exceptions an environment heading needs.
       */

      case 'ArrowLeft': {
        event.preventDefault();
        const state = expansionOf(item);
        if (item.kind === 'group' && !item.collapsed) {
          fold(item.environment, true);
          return;
        }
        if (state?.expandable && state.expanded) {
          collapse(item);
          return;
        }
        const parent = handle.parentOf(i);
        if (parent >= 0) {
          handle.focusIndex(parent);
        }
        return;
      }

      case 'ArrowRight': {
        event.preventDefault();
        const state = expansionOf(item);
        if (item.kind === 'group') {
          if (item.collapsed) {
            fold(item.environment, false);
          } else if (i + 1 < n) {
            handle.focusIndex(i + 1);
          }
          return;
        }
        if (state?.expandable && !state.expanded) {
          open(item);
          return;
        }
        if (header || state?.expanded) {
          if (i + 1 < n) {
            handle.focusIndex(i + 1);
          }
        }
        return;
      }

      case 'Enter':
        event.preventDefault();
        activate(item);
        return;

      case ' ':
        event.preventDefault();
        if (item.kind === 'group') {
          fold(item.environment, !item.collapsed);
          return;
        }
        if (item.kind !== 'row') {
          // Everything inside a connection has one meaning for both keys, so
          // Space is Enter there. Only a connection row distinguishes them,
          // because only a connection has a session to open or close.
          activate(item);
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
        // Connections only. Nothing inside a connection is deletable from a
        // tree: dropping a table is a statement somebody writes and runs, not
        // a keypress in a sidebar.
        if (item.kind === 'row') {
          event.preventDefault();
          post({ type: 'delete', id: item.id });
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
