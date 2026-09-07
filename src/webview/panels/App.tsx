import { useCallback, useState } from 'react';
import { createStore, useStoreSelector } from '../state/store';
import {
  DependencyRef,
  HistoryRow,
  ObjectDetails,
  PanelHostMessage,
  SavedRow,
  Tag
} from '../../shared/details';
import { EnvironmentId } from '../../types';
import { Codicon } from '../primitives/Codicon';
import { ObjectIcon } from '../primitives/ObjectIcon';
import { post, readOpen, viewName, writeOpen } from './vscode';

const VIEW = viewName();

interface PanelState {
  details: ObjectDetails | null;
  history: HistoryRow[];
  saved: SavedRow[];
  connections: { id: string; name: string; environment: EnvironmentId }[];
  filter: string | undefined;
}

const store = createStore<PanelState>({
  details: null,
  history: [],
  saved: [],
  connections: [],
  filter: undefined
});

export function applyHostMessage(message: PanelHostMessage): void {
  switch (message.type) {
    case 'details':
      store.setState((state) => ({ ...state, details: message.details }));
      return;
    case 'history':
      store.setState((state) => ({ ...state, history: message.entries, connections: message.connections }));
      return;
    case 'saved':
      store.setState((state) => ({ ...state, saved: message.entries }));
      return;
    default:
      return;
  }
}

function usePanel<T>(select: (state: PanelState) => T): T {
  return useStoreSelector(store, useCallback(select, []));
}

export function App(): JSX.Element {
  return VIEW === 'history' ? <History /> : <Details />;
}

/* ----------------------------------------------------------------- details */

function Details(): JSX.Element {
  const details = usePanel((state) => state.details);
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ columns: true, ...readOpen() }));

  const toggle = (id: string) => {
    setOpen((current) => {
      const next = { ...current, [id]: !current[id] };
      writeOpen(next);
      return next;
    });
  };

  if (!details) {
    return (
      <div className="empty">
        <Codicon name="database" />
        <p className="empty-title">No object selected</p>
        <p className="empty-body">Click a table, view or routine in the explorer.</p>
      </div>
    );
  }

  return (
    <div className="details">
      <div className="details-head">
        <ObjectIcon mark={details.ref.kind} />
        <div className="details-title">
          <div className="details-name">
            {details.ref.schema}.{details.ref.name}
          </div>
          <div className="details-sub">
            {details.ref.kind} · {details.driver === 'mssql' ? 'SQL Server' : 'PostgreSQL'} ·{' '}
            {details.connectionName}
          </div>
        </div>
      </div>

      {details.error ? (
        <div className="details-error">
          <Codicon name="error" />
          <span>{details.error}</span>
        </div>
      ) : null}

      {details.tags?.length ? (
        <div className="tags">
          {details.tags.map((tag) => (
            <TagChip key={tag.id + tag.label} tag={tag} />
          ))}
        </div>
      ) : null}

      {details.facts?.length ? (
        <dl className="facts">
          {details.facts.map((fact) => (
            <div className="fact" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd className={fact.value === null ? 'is-absent' : 'num'} title={fact.absent}>
                {fact.value === null ? '—' : `${fact.approximate ? '~' : ''}${fact.value}`}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="actions">
        <Action id="viewData" icon="table" label="View Data" kind={details.ref.kind} />
        <Action id="run" icon="play" label="Run…" kind={details.ref.kind} />
        <Action id="generateCrud" icon="symbol-method" label="Generate CRUD" kind={details.ref.kind} />
        <Action id="scriptCreate" icon="file-code" label="Script CREATE" kind={details.ref.kind} />
        <Action id="scriptAlter" icon="edit" label="Script ALTER" kind={details.ref.kind} />
        <Action id="dependencies" icon="references" label="Dependencies" kind={details.ref.kind} />
        <Action id="compare" icon="diff" label="Compare With" kind={details.ref.kind} />
        <Action id="scriptDrop" icon="trash" label="Script DROP" kind={details.ref.kind} />
      </div>

      <Section
        id="columns"
        label="Columns"
        count={details.columns?.length}
        open={open.columns}
        onToggle={toggle}
      >
        {details.columns?.map((column) => (
          <div className="row" key={column.name}>
            {column.key ? <Codicon name="key" /> : column.ref ? <Codicon name="link" /> : <span className="row-gap" />}
            <span className="row-name">{column.name}</span>
            <span className="strip-spacer" />
            <span className="mono dim">
              {column.type}
              {column.auto ? ' auto' : ''}
              {column.nullable === false ? '' : ' null'}
            </span>
          </div>
        ))}
      </Section>

      <Section id="indexes" label="Indexes" count={details.indexes?.length} open={open.indexes} onToggle={toggle}>
        {details.indexes?.map((index) => (
          <div className="row" key={index.name}>
            <Codicon name={index.primary ? 'key' : 'list-ordered'} />
            <span className="row-name">{index.name}</span>
            <span className="strip-spacer" />
            <span className="mono dim">{index.columns.join(', ')}</span>
          </div>
        ))}
      </Section>

      <Section
        id="dependsOn"
        label="Depends on"
        count={details.dependsOn?.length}
        open={open.dependsOn}
        onToggle={toggle}
      >
        {details.dependsOn?.map((dependency, i) => <Dependency key={i} dependency={dependency} />)}
      </Section>

      <Section id="usedBy" label="Used by" count={details.usedBy?.length} open={open.usedBy} onToggle={toggle}>
        {details.usedBy?.map((dependency, i) => <Dependency key={i} dependency={dependency} />)}
        {details.usedBy?.some((dependency) => dependency.inferred) ? (
          <p className="footnote">
            The dimmed rows were matched in source text, not tracked by the server. PostgreSQL does not record what
            a routine body reads, so a name inside a comment can match.
          </p>
        ) : null}
      </Section>
    </div>
  );
}

function TagChip({ tag }: { tag: Tag }): JSX.Element {
  return (
    <span className={`tag tag-${tag.id}`} title={tag.detail}>
      {tag.label}
    </span>
  );
}

function Action({
  id,
  icon,
  label,
  kind
}: {
  id: string;
  icon: string;
  label: string;
  kind: string;
}): JSX.Element | null {
  const relational = kind === 'table' || kind === 'view';
  const routine = kind === 'procedure' || kind === 'function';
  if ((id === 'viewData' && !relational) || (id === 'run' && !routine) || (id === 'generateCrud' && kind !== 'table')) {
    return null;
  }
  return (
    <button type="button" className="action" onClick={() => post({ type: 'action', action: id as never })}>
      <Codicon name={icon} />
      {label}
    </button>
  );
}

function Dependency({ dependency }: { dependency: DependencyRef }): JSX.Element {
  return (
    <div className={`row${dependency.inferred ? ' is-inferred' : ''}`}>
      <ObjectIcon mark={dependency.kind === 'constraint' ? 'ref' : dependency.kind} />
      <span className="row-name">
        {dependency.schema}.{dependency.name}
      </span>
      <span className="strip-spacer" />
      <span className="dim">{dependency.why}</span>
    </div>
  );
}

function Section({
  id,
  label,
  count,
  open,
  onToggle,
  children
}: {
  id: string;
  label: string;
  count: number | undefined;
  open: boolean | undefined;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}): JSX.Element | null {
  if (count === undefined) {
    return null;
  }
  return (
    <section className="section">
      <button type="button" className="section-head" aria-expanded={Boolean(open)} onClick={() => onToggle(id)}>
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{label}</span>
        <span className="strip-spacer" />
        <span className="num dim">{count}</span>
      </button>
      {open ? <div className="section-body">{children}</div> : null}
    </section>
  );
}

/* ----------------------------------------------------------------- history */

function History(): JSX.Element {
  const history = usePanel((state) => state.history);
  const saved = usePanel((state) => state.saved);
  const connections = usePanel((state) => state.connections);
  const filter = usePanel((state) => state.filter);
  const [text, setText] = useState('');

  const matching = history.filter((entry) =>
    text.trim() ? entry.sql.toLowerCase().includes(text.trim().toLowerCase()) : true
  );

  return (
    <div className="history">
      <div className="history-bar">
        <label className="search">
          <Codicon name="search" />
          <input
            type="search"
            placeholder="Search history…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <select
          className="picker"
          value={filter ?? ''}
          aria-label="Connection"
          onChange={(event) => {
            store.setState((state) => ({ ...state, filter: event.target.value || undefined }));
            post({ type: 'filterHistory', profileId: event.target.value || undefined });
          }}
        >
          <option value="">All connections</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          title="Clear history"
          onClick={() => post({ type: 'clearHistory', profileId: filter })}
        >
          <Codicon name="trash" />
        </button>
      </div>

      {matching.length === 0 ? (
        <div className="empty">
          <Codicon name="history" />
          <p className="empty-title">Nothing yet</p>
          <p className="empty-body">Statements you run appear here, failures included.</p>
        </div>
      ) : (
        <div className="entries">
          {matching.map((entry) => (
            <div
              key={entry.id}
              className={`entry status-${entry.status}`}
              onDoubleClick={() => post({ type: 'openHistory', id: entry.id })}
            >
              <div className="entry-meta">
                <Codicon
                  name={entry.status === 'error' ? 'error' : entry.status === 'cancelled' ? 'circle-slash' : 'check'}
                />
                <span className="num">{new Date(entry.at).toLocaleTimeString()}</span>
                {entry.status === 'error' ? (
                  <span className="entry-error">{entry.error}</span>
                ) : (
                  <>
                    <span className="num dim">{formatMs(entry.durationMs)}</span>
                    <span className="num dim">{entry.rows.toLocaleString('en-US')} rows</span>
                  </>
                )}
                <span className="strip-spacer" />
                <span className="dim">{entry.connectionName}</span>
              </div>
              <div className={`entry-sql mono${entry.redacted ? ' is-redacted' : ''}`}>
                {entry.redacted ? 'Statement withheld — it set a credential' : entry.sql}
              </div>
              {entry.redacted ? null : (
                <div className="entry-actions">
                  <button type="button" className="link" onClick={() => post({ type: 'openHistory', id: entry.id })}>
                    Open
                  </button>
                  <button type="button" className="link" onClick={() => post({ type: 'copyHistory', id: entry.id })}>
                    Copy
                  </button>
                  <button type="button" className="link" onClick={() => post({ type: 'saveHistory', id: entry.id })}>
                    Save
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <section className="section saved">
        <div className="section-head static">
          <Codicon name="bookmark" />
          <span>Saved queries</span>
          <span className="strip-spacer" />
          <span className="num dim">{saved.length}</span>
        </div>
        <div className="section-body">
          {saved.map((entry) => (
            <button
              key={entry.uri}
              type="button"
              className="row row-button"
              onClick={() => post({ type: 'openSaved', uri: entry.uri })}
              title={entry.description}
            >
              <Codicon name="bookmark" />
              <span className="row-name">{entry.name}</span>
              <span className="strip-spacer" />
              <span className="dim">{entry.connectionName}</span>
            </button>
          ))}
          {saved.length === 0 ? <p className="footnote">Save a query to keep it as a file you can review.</p> : null}
        </div>
      </section>
    </div>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
