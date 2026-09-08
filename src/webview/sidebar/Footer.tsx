import { useEffect, useMemo, useRef, useState } from 'react';
import { SessionUpdate } from '../../shared/sidebar';
import { Codicon } from '../primitives/Codicon';
import { useStoreSelector } from '../state/store';
import { post } from './api';
import { fullHost } from './host';
import { Counts, CursorState, ListState, SessionMap, countsStore, cursorStore, listStore, sessionStore } from './state';

const selCount = (s: ListState) => s.rows.length;
const selById = (s: ListState) => s.byId;
const selQuery = (s: ListState) => s.query;
const selSessions = (s: SessionMap) => s;
const selCursor = (s: CursorState) => s.cursorId;
const selCounts = (c: Counts) => c;

/**
 * The same words the tree's accessibility information used, so nothing an
 * assistive-technology user relies on changes wording. The two in-flight kinds
 * are kept apart because the host now distinguishes them and a row that says
 * the wrong one is a row that lies.
 */
function stateWord(session: SessionUpdate | undefined): string {
  if (!session) {
    return 'saved, not connected';
  }
  switch (session.state) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'testing':
      return 'testing';
    case 'failed':
      return session.failure ? `last attempt failed, ${session.failure}` : 'last attempt failed';
  }
}

interface Props {
  /** Bring a row into view without taking focus off the band's own button. */
  onReveal: (id: string) => void;
}

/**
 * The 22px strip: counts at rest, the cursor row's detail when there is a
 * cursor, and a production alarm above both.
 *
 * It follows the cursor and never the pointer. Slaving it to hover means
 * dragging the mouse down eighty-four rows rewrites the bar eighty-four times,
 * which is a bar the eye learns to discount — with the production alarm inside
 * it. Driven by the cursor it changes at click and keypress rate, the mouse and
 * keyboard paths are the same one, hover writes no state at all, and there is
 * no dwell delay to tune. Hover still gets the full string through `title`.
 */
export function Footer({ onReveal }: Props): JSX.Element {
  const total = useStoreSelector(listStore, selCount);
  const byId = useStoreSelector(listStore, selById);
  const query = useStoreSelector(listStore, selQuery);
  const sessions = useStoreSelector(sessionStore, selSessions);
  const cursorId = useStoreSelector(cursorStore, selCursor);
  const matchCounts = useStoreSelector(countsStore, selCounts);

  const counts = useMemo(() => {
    let live = 0;
    let failed = 0;
    let busy = 0;
    for (const id in sessions) {
      if (!byId[id]) {
        continue;
      }
      const state = sessions[id].state;
      if (state === 'connected') {
        live++;
      } else if (state === 'failed') {
        failed++;
      } else {
        busy++;
      }
    }
    return { live, failed, saved: Math.max(0, total - live - failed - busy) };
  }, [sessions, byId, total]);

  // The counts `flatten` published for this query, or nothing while there is
  // no query and the strip shows the plain total.
  const filtered = query.trim() ? matchCounts : null;

  // A section header's cursor id is never a profile id, so resting on one
  // misses this lookup and the strip shows the counts rather than a stale row.
  const cursorRow = cursorId ? byId[cursorId] : undefined;
  const readout = cursorRow
    ? [
        fullHost(cursorRow),
        cursorRow.database || 'no database',
        stateWord(sessions[cursorRow.id]),
        ...(cursorRow.readOnly ? ['Read-only'] : [])
      ].join(' · ')
    : '';

  /**
   * Read from the session store and never from the flattened index, so no
   * search and no folded group can hide the fact that a production session is
   * open.
   */
  const production = useMemo(() => {
    const open: SessionUpdate[] = [];
    for (const id in sessions) {
      if (sessions[id].state === 'connected' && byId[id]?.environment === 'prod') {
        open.push(sessions[id]);
      }
    }
    return open;
  }, [sessions, byId]);

  const first = production[0];
  const readWrite = production.length === 1 && first?.session?.readOnly === false;
  const bandText =
    production.length === 1
      ? `${byId[first.id]?.name ?? 'A production session'}${readWrite ? '' : ' · read-only'}`
      : `${production.length} production sessions`;

  const [alarm, setAlarm] = useState('');
  const wasOpen = useRef(0);
  useEffect(() => {
    const now = production.length;
    const rising = wasOpen.current === 0 && now > 0;
    wasOpen.current = now;
    if (!rising) {
      return;
    }
    // Two elements rather than one whose role changes: mutating `role` on a
    // live element is unreliable across screen readers.
    setAlarm(`A production session is open: ${bandText}.`);
    const id = window.setTimeout(() => setAlarm(''), 5000);
    return () => window.clearTimeout(id);
  }, [production.length, bandText]);

  const [failure, setFailure] = useState('');
  const seen = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const now = new Set<string>();
    let fresh: string | null = null;
    for (const id in sessions) {
      if (sessions[id].state !== 'failed') {
        continue;
      }
      now.add(id);
      if (!seen.current.has(id)) {
        fresh = sessions[id].failure ?? null;
      }
    }
    seen.current = now;
    if (fresh === null) {
      return;
    }
    setFailure(fresh);
    const id = window.setTimeout(() => setFailure(''), 5000);
    return () => window.clearTimeout(id);
  }, [sessions]);

  const spoken = `${counts.live} connected, ${counts.saved} saved, ${counts.failed} failed, ${total} total`;

  return (
    <footer className="footer" aria-label="Connection counts">
      {production.length > 0 && (
        <div className="prod-band env-prod" role="status">
          <Codicon name="shield" />
          {production.length === 1 ? (
            <button type="button" onClick={() => onReveal(first.id)}>
              {byId[first.id]?.name ?? 'Production session'}
            </button>
          ) : (
            <span>{bandText}</span>
          )}
          {production.length === 1 && (
            <span>{readWrite ? <strong>READ-WRITE</strong> : 'read-only'}</span>
          )}
          <button
            type="button"
            onClick={() => {
              for (const session of production) {
                post({ type: 'disconnect', id: session.id });
              }
            }}
          >
            {production.length === 1 ? 'Close' : 'Close all'}
          </button>
        </div>
      )}
      <span className="sr-only" role="alert">
        {alarm}
      </span>

      {/*
        The counts stay mounted and stay a live region even while the readout is
        showing, because "3 connected" has to be announced when a session opens
        whatever the cursor happens to be resting on.
      */}
      <div className={readout ? 'counts sr-only' : 'counts'} aria-live="polite" title={spoken}>
        <span className="sr-only">{spoken}</span>
        <span aria-hidden="true">
          <Codicon name="circle-filled" />
          {counts.live}
        </span>
        <span aria-hidden="true">
          <Codicon name="circle-outline" />
          {counts.saved}
        </span>
        {counts.failed > 0 && (
          <span aria-hidden="true">
            <Codicon name="warning" />
            {counts.failed}
          </span>
        )}
        <span aria-hidden="true">
          {filtered
            ? `${filtered.matched} of ${total}${
                filtered.productionHidden > 0 ? ` · ${filtered.productionHidden} production hidden` : ''
              }`
            : total}
        </span>
      </div>

      {/*
        Everything here is already in the row's accessible name, and a region
        that re-announced on every cursor move would be unusable.
      */}
      {readout !== '' && (
        <div className="readout mono" aria-hidden="true" title={readout}>
          {readout}
        </div>
      )}

      <span className="sr-only" role="alert">
        {failure}
      </span>
    </footer>
  );
}
