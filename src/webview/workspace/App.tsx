import { useCallback, useEffect } from 'react';
import { CellRange, CopyShape, ExportFormat, RunnerValue } from '../../shared/query';
import { Codicon } from '../primitives/Codicon';
import { Grid } from '../grid/Grid';
import { post, viewName } from './vscode';
import {
  ResultTab,
  setDetail,
  setFilter,
  setNotice,
  setSetIndex,
  setTab,
  setValue,
  useWorkspace
} from './store';
import { Detail, Empty, FORMATS, Messages, Plan, StatusStrip, Truncated, count } from './parts';

const VIEW = viewName();

export function App(): JSX.Element {
  const execution = useWorkspace((state) => state.execution);
  const notice = useWorkspace((state) => state.notice);
  const detail = useWorkspace((state) => state.detail);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div className={`app view-${VIEW}`}>
      {VIEW === 'runner' ? <Runner /> : null}
      {VIEW === 'data' ? <DataToolbar /> : null}
      {execution ? <ResultsArea /> : <NoResults />}
      {detail ? <Detail value={detail.value} column={detail.column} onClose={() => setDetail(null)} /> : null}
      {notice ? (
        <div className={`toast tone-${notice.level}`} role="status">
          <Codicon name={notice.level === 'error' ? 'error' : 'check'} />
          <span>{notice.text}</span>
        </div>
      ) : null}
    </div>
  );
}

function NoResults(): JSX.Element {
  if (VIEW === 'runner') {
    return <Empty icon="play" title="Nothing has run yet" body="Fill the form and press Execute." />;
  }
  if (VIEW === 'data') {
    return <Empty icon="table" title="Loading" body="Reading the first page." />;
  }
  return (
    <Empty
      icon="table"
      title="No results yet"
      body="Run a statement with F5 or Ctrl+Enter. Results for the tab you are on appear here."
    />
  );
}

/* ----------------------------------------------------------------- results */

function ResultsArea(): JSX.Element {
  const execution = useWorkspace((state) => state.execution);
  const tab = useWorkspace((state) => state.tab);
  const setIndex = useWorkspace((state) => state.setIndex);
  const plan = useWorkspace((state) => state.plan);
  const filter = useWorkspace((state) => state.filter);
  const revision = useWorkspace((state) => state.revision);

  const request = useCallback(
    (offset: number, size: number) => {
      if (execution) {
        post({ type: 'getRows', executionId: execution.id, setIndex, offset, count: size });
      }
    },
    [execution?.id, setIndex]
  );

  if (!execution) {
    return <NoResults />;
  }
  const set = execution.sets[setIndex];

  const onSort = (column: number, direction: 'asc' | 'desc' | null) =>
    post({ type: 'sort', executionId: execution.id, setIndex, column, direction });

  const onCopy = (range: CellRange, shape: CopyShape) =>
    post({ type: 'copy', executionId: execution.id, setIndex, range, shape });

  return (
    <div className="results">
      {VIEW === 'results' ? (
        <div className="tabs" role="tablist">
          {(['results', 'messages', 'plan'] as ResultTab[]).map((id) => {
            if (id === 'plan' && !execution.hasPlan && !plan) {
              return null;
            }
            const errors = id === 'messages' && execution.error;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`tab${tab === id ? ' is-on' : ''}${errors ? ' has-error' : ''}`}
                onClick={() => setTab(id)}
              >
                {id}
                {errors ? <Codicon name="error" /> : null}
              </button>
            );
          })}
          <span className="strip-spacer" />
          <GridToolbar
            filter={filter}
            executionId={execution.id}
            setIndex={setIndex}
            running={execution.status === 'running'}
          />
        </div>
      ) : null}

      {execution.sets.length > 1 ? (
        <div className="setbar">
          {execution.sets.map((candidate) => (
            <button
              key={candidate.index}
              type="button"
              className={`chip${candidate.index === setIndex ? ' is-on' : ''}`}
              onClick={() => setSetIndex(candidate.index)}
            >
              Result {candidate.index + 1} · {count(candidate.rowCount)} rows
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'results' && set && set.columns.length > 0 ? (
        <>
          {set.sort && !set.sort.server ? (
            <div className="honest">
              <Codicon name="info" />
              <span>
                Sorted within the {count(set.rowCount)} fetched rows, not the whole result. Add an ORDER BY and
                run it again to sort on the server.
              </span>
            </div>
          ) : null}
          <Grid
            executionId={execution.id}
            set={set}
            request={request}
            onSort={onSort}
            onCopy={onCopy}
            onOpenCell={(value, column) => setDetail({ value, column })}
            revision={revision}
          />
          {set.truncated ? (
            <Truncated
              fetched={set.rowCount}
              onMore={() => post({ type: 'fetchMore', executionId: execution.id, all: false })}
              onAll={() => post({ type: 'fetchMore', executionId: execution.id, all: true })}
            />
          ) : null}
        </>
      ) : null}

      {tab === 'results' && (!set || set.columns.length === 0) ? (
        <Empty
          icon="check"
          title={execution.status === 'error' ? 'The statement failed' : 'No rows returned'}
          body={
            execution.status === 'error'
              ? 'The Messages tab has what the server said.'
              : 'The statement ran and produced no result set.'
          }
        />
      ) : null}

      {tab === 'messages' ? (
        <Messages execution={execution} onGoToError={() => post({ type: 'goToError', executionId: execution.id })} />
      ) : null}

      {tab === 'plan' && plan ? <Plan plan={plan} /> : null}

      {VIEW === 'data' ? <DataFooter /> : <StatusStrip execution={execution}>{
        execution.status === 'running' ? (
          <button type="button" className="btn btn-stop" onClick={() => post({ type: 'cancel', executionId: execution.id })}>
            <Codicon name="debug-stop" />
            Stop
          </button>
        ) : null
      }</StatusStrip>}
    </div>
  );
}

function GridToolbar({
  filter,
  executionId,
  setIndex,
  running
}: {
  filter: string;
  executionId: string;
  setIndex: number;
  running: boolean;
}): JSX.Element {
  return (
    <div className="toolbar">
      <label className="search">
        <Codicon name="search" />
        <input
          type="search"
          value={filter}
          placeholder="Filter rows…"
          onChange={(event) => {
            setFilter(event.target.value);
            post({ type: 'filter', executionId, text: event.target.value, server: false });
          }}
        />
      </label>
      <ExportMenu executionId={executionId} setIndex={setIndex} />
      {running ? (
        <button type="button" className="icon-btn" title="Stop" onClick={() => post({ type: 'cancel', executionId })}>
          <Codicon name="debug-stop" />
        </button>
      ) : null}
    </div>
  );
}

function ExportMenu({ executionId, setIndex }: { executionId: string; setIndex: number }): JSX.Element {
  return (
    <div className="menu">
      <button type="button" className="icon-btn" title="Export">
        <Codicon name="desktop-download" />
      </button>
      <div className="menu-list" role="menu">
        {FORMATS.map((format) => (
          <button
            key={format.id}
            type="button"
            role="menuitem"
            onClick={() =>
              post({ type: 'export', executionId, setIndex, format: format.id as ExportFormat })
            }
          >
            {format.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- table data */

function DataToolbar(): JSX.Element {
  const execution = useWorkspace((state) => state.execution);
  const filter = useWorkspace((state) => state.filter);
  if (!execution?.table) {
    return <div className="data-toolbar" />;
  }
  const table = execution.table;
  return (
    <div className="data-toolbar">
      <span className="obj-mark" aria-hidden="true" />
      <span className="obj-name">
        {table.ref.schema}.{table.ref.name}
      </span>
      <label className="search">
        <Codicon name="search" />
        <input
          type="search"
          value={filter}
          placeholder="Filter — becomes a WHERE"
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              post({ type: 'filter', executionId: execution.id, text: filter, server: true });
            }
          }}
        />
      </label>
      <span className="strip-spacer" />
      <button
        type="button"
        className="icon-btn"
        title="Refresh"
        onClick={() => post({ type: 'refresh', executionId: execution.id })}
      >
        <Codicon name="refresh" />
      </button>
      <ExportMenu executionId={execution.id} setIndex={0} />
      <span className="num dim">
        {table.estimate === undefined ? '—' : `~${count(table.estimate)} rows`}
      </span>
    </div>
  );
}

function DataFooter(): JSX.Element {
  const execution = useWorkspace((state) => state.execution);
  if (!execution?.table) {
    return <div />;
  }
  const table = execution.table;
  const first = table.page * table.pageSize + 1;
  const last = table.page * table.pageSize + execution.rowsFetched;
  return (
    <div className="strip">
      <span className="num">
        Rows {count(first)}–{count(last)}
        {table.estimate === undefined ? '' : ` of ~${count(table.estimate)}`}
      </span>
      <span className="num">{execution.elapsedMs} ms</span>
      <span className="strip-lock">
        <Codicon name="lock" />
        Read-only · Generate CRUD to write
      </span>
      <span className={table.keyset ? 'strip-ok' : 'strip-warn'}>
        {table.keyset
          ? `Keyset paged on ${table.ref.name} key — constant time at any depth`
          : 'No unique key, so paging skips rows. Deep pages get slower.'}
      </span>
      <span className="strip-spacer" />
      <button
        type="button"
        className="icon-btn"
        disabled={table.page === 0}
        aria-label="Previous page"
        onClick={() => post({ type: 'page', executionId: execution.id, delta: -1 })}
      >
        <Codicon name="chevron-left" />
      </button>
      <button
        type="button"
        className="icon-btn"
        disabled={!table.hasMore}
        aria-label="Next page"
        onClick={() => post({ type: 'page', executionId: execution.id, delta: 1 })}
      >
        <Codicon name="chevron-right" />
      </button>
      <select
        className="page-size"
        value={table.pageSize}
        aria-label="Rows per page"
        onChange={(event) => post({ type: 'pageSize', executionId: execution.id, size: Number(event.target.value) })}
      >
        {[100, 200, 500, 1000, 5000].map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------ runner */

function Runner(): JSX.Element {
  const form = useWorkspace((state) => state.form);
  const values = useWorkspace((state) => state.values);
  const execution = useWorkspace((state) => state.execution);

  if (!form) {
    return <div className="runner runner-loading">Reading the parameter list…</div>;
  }

  const valueOf = (name: string): RunnerValue => values[name] ?? { null: false, text: '' };

  return (
    <div className="runner">
      <div className="runner-head">
        <span className="obj-mark obj-routine" aria-hidden="true" />
        <div>
          <div className="runner-name">
            {form.ref.schema}.{form.ref.name}
          </div>
          <div className="runner-sub">
            {form.parameters.length} parameter{form.parameters.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="runner-form">
        {form.parameters.map((parameter) => {
          const value = valueOf(parameter.name);
          const disabled = value.null;
          return (
            <div className="field" key={parameter.name}>
              <div className="field-label">
                <span>{parameter.label}</span>
                {parameter.required ? <span className="req">REQUIRED</span> : null}
                <span className="strip-spacer" />
                <span className="mono dim">
                  {parameter.type}
                  {parameter.direction !== 'in' ? ` · ${parameter.direction}` : ''}
                </span>
              </div>

              {parameter.control === 'bool' ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!value.null && (value.text === '1' || value.text.toLowerCase() === 'true')}
                    onChange={(event) => setValue(parameter.name, { null: false, text: event.target.checked ? '1' : '0' })}
                  />
                  <span>{parameter.label}</span>
                </label>
              ) : parameter.control === 'multiline' ? (
                <textarea
                  className="input"
                  rows={3}
                  disabled={disabled}
                  value={value.null ? '' : value.text}
                  onChange={(event) => setValue(parameter.name, { null: false, text: event.target.value })}
                />
              ) : (
                <input
                  className="input"
                  type={parameter.control === 'number' ? 'number' : 'text'}
                  disabled={disabled}
                  value={value.null ? '' : value.text}
                  onChange={(event) => setValue(parameter.name, { null: false, text: event.target.value })}
                />
              )}

              {parameter.nullable && parameter.control !== 'bool' ? (
                <label className="null-toggle">
                  <input
                    type="checkbox"
                    checked={value.null}
                    onChange={(event) =>
                      setValue(parameter.name, event.target.checked ? { null: true } : { null: false, text: '' })
                    }
                  />
                  <span className="mono">NULL</span>
                </label>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="runner-actions">
        <span className="dim">
          Values are bound as parameters, never concatenated. Arguments are remembered for this connection only.
        </span>
        <span className="strip-spacer" />
        <button
          type="button"
          className="btn btn-p"
          disabled={execution?.status === 'running'}
          onClick={() => post({ type: 'run', values })}
        >
          <Codicon name="play" />
          Execute
          <span className="key">F5</span>
        </button>
      </div>

      {execution?.outputs?.length ? (
        <div className="outputs">
          <span className="outputs-title">Output parameters</span>
          {execution.outputs.map((output) => (
            <span key={output.name} className="output">
              <span className="mono">{output.name}</span>
              <span className="mono dim">{output.value === null ? 'NULL' : String(output.value)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
