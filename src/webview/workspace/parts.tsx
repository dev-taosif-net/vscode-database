import { CellValue, ColumnMeta, ExecutionInfo, ExportFormat, PlanNode, PlanPayload } from '../../shared/query';
import { Codicon } from '../primitives/Codicon';
import { cellText } from '../../shared/query';

/** How long something took, in the unit a person would say it in. */
function duration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

export function StatusStrip({
  execution,
  children
}: {
  execution: ExecutionInfo;
  children?: React.ReactNode;
}): JSX.Element {
  const rows = execution.rowsFetched;
  return (
    <div className="strip" role="status">
      {execution.status === 'running' ? (
        <span className="strip-live">
          <Codicon name="sync" spin />
          Streaming
        </span>
      ) : null}
      {execution.status === 'cancelled' ? (
        <span className="strip-warn">
          <Codicon name="circle-slash" />
          Cancelled after {count(rows)} rows — what was fetched is kept
        </span>
      ) : null}
      {execution.status === 'error' ? (
        <span className="strip-error">
          <Codicon name="error" />
          Failed
        </span>
      ) : null}
      <span className="num">{count(rows)} rows</span>
      <span className="num">{duration(execution.elapsedMs)}</span>
      {execution.rowsAffected !== undefined ? (
        <span className="num">{count(execution.rowsAffected)} affected</span>
      ) : null}
      {children}
      <span className="strip-spacer" />
      <span className="strip-connection">
        <span className={`dot env-${execution.environment}`} aria-hidden="true" />
        {execution.connectionName}
        {execution.database ? ` · ${execution.database}` : ''}
        {execution.readOnly ? ' · read-only' : ''}
      </span>
    </div>
  );
}

export const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'tsv', label: 'TSV' },
  { id: 'xlsx', label: 'Excel' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL inserts' },
  { id: 'markdown', label: 'Markdown' }
];

export function Empty({ icon, title, body }: { icon: string; title: string; body: string }): JSX.Element {
  return (
    <div className="empty">
      <Codicon name={icon} />
      <p className="empty-title">{title}</p>
      <p className="empty-body">{body}</p>
    </div>
  );
}

/**
 * The truncation strip.
 *
 * It says the read stopped and offers to run again for more, and it says
 * "run again" rather than "fetch more" because that is what happens: holding a
 * server cursor open across a tab's lifetime would mean holding a transaction
 * on a shared database for as long as somebody leaves a window open.
 */
export function Truncated({
  fetched,
  onMore,
  onAll
}: {
  fetched: number;
  onMore: () => void;
  onAll: () => void;
}): JSX.Element {
  return (
    <div className="truncated">
      <span>
        Fetched <span className="num">{count(fetched)}</span> rows. The server has more.
      </span>
      <button type="button" className="btn btn-p" onClick={onMore}>
        Run again for more
      </button>
      <button type="button" className="btn" onClick={onAll}>
        Run again for all
      </button>
    </div>
  );
}

export function Messages({
  execution,
  onGoToError
}: {
  execution: ExecutionInfo;
  onGoToError: () => void;
}): JSX.Element {
  if (execution.messages.length === 0) {
    return <Empty icon="comment" title="No messages" body="PRINT, RAISE NOTICE and row counts appear here." />;
  }
  return (
    <div className="messages">
      {execution.messages.map((message, index) => (
        <div key={index} className={`message tone-${message.level}`}>
          <Codicon name={message.level === 'error' ? 'error' : 'info'} />
          <div className="message-body">
            <pre>{message.text}</pre>
            {message.line !== undefined ? (
              <button type="button" className="link" onClick={onGoToError}>
                Go to line {message.line}
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The plan, as an operator tree.
 *
 * Indented rather than drawn as a graph on purpose: a tree is readable at any
 * depth and a force-directed blob is not, and the thing people are looking for
 * — which operator is eating the plan — is a column of percentages.
 */
export function Plan({ plan }: { plan: PlanPayload }): JSX.Element {
  if (!plan.root) {
    return <Empty icon="type-hierarchy" title="No plan" body="The server did not return one for this statement." />;
  }
  return (
    <div className="plan">
      {plan.warnings.length ? (
        <div className="plan-warnings">
          {plan.warnings.map((warning, index) => (
            <div key={index} className="plan-warning">
              <Codicon name="warning" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="plan-tree" role="tree">
        <PlanRow node={plan.root} depth={0} />
      </div>
      <div className="plan-stats">
        {plan.stats.map((stat) => (
          <span key={stat.label} className="num">
            {stat.label} {stat.value}
          </span>
        ))}
        <span>{plan.actual ? 'Actual plan' : 'Estimated plan'}</span>
      </div>
    </div>
  );
}

function PlanRow({ node, depth }: { node: PlanNode; depth: number }): JSX.Element {
  const share = Math.round(node.cost * 100);
  const heavy = share >= 25;
  return (
    <>
      <div className="plan-node" role="treeitem" style={{ ['--depth' as string]: depth }}>
        <span className={`plan-cost${heavy ? ' is-heavy' : ''}`}>
          <span className="plan-bar" style={{ width: `${Math.min(100, share)}%` }} />
          <span className="num">{share}%</span>
        </span>
        <span className="plan-op">{node.operation}</span>
        {node.detail ? <span className="plan-detail">{node.detail}</span> : null}
        {node.object ? <span className="plan-object mono">{node.object}</span> : null}
        <span className="plan-rows num">
          {node.actualRows !== undefined
            ? `${count(node.actualRows)} rows`
            : node.estimatedRows !== undefined
              ? `~${count(Math.round(node.estimatedRows))} rows`
              : ''}
          {node.executions && node.executions > 1 ? ` · ${count(node.executions)}×` : ''}
        </span>
        {node.warnings.length ? <Codicon name="warning" /> : null}
      </div>
      {node.children.map((child) => (
        <PlanRow key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

/** One value, expanded. The escape hatch for anything wider than a cell. */
export function Detail({
  value,
  column,
  onClose
}: {
  value: CellValue;
  column: ColumnMeta;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="detail">
      <div className="detail-head">
        <span className="detail-name">{column.name}</span>
        <span className="detail-type mono">{column.type}</span>
        <span className="strip-spacer" />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Codicon name="close" />
        </button>
      </div>
      <pre className="detail-body">{value === null ? 'NULL' : cellText(value)}</pre>
    </div>
  );
}
