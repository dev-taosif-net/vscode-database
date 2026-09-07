import { PlanNode, PlanPayload } from '../shared/query';
import { DriverKind } from '../types';
import { XmlElement, childrenNamed, descendants, firstNamed, parseXml } from './xml';

export type PlanMode = 'none' | 'estimated' | 'actual';

/**
 * The column SQL Server puts a showplan in.
 *
 * The name has not changed since 2005 and is the same for `SHOWPLAN_XML` and
 * `STATISTICS XML`, which is what lets one check route both. It is matched
 * rather than assumed from position because a batch can return the plan
 * alongside ordinary result sets, and the plan is not always last.
 */
const SHOWPLAN_COLUMN = 'Microsoft SQL Server 2005 XML Showplan';

export function isPlanColumn(name: string): boolean {
  return name === SHOWPLAN_COLUMN || name === 'QUERY PLAN';
}

/**
 * How a statement is asked for its plan, per engine and per mode.
 *
 * The two engines differ in a way that matters to the user rather than only to
 * the code. SQL Server can produce an estimated plan without running anything:
 * `SHOWPLAN_XML` makes the server compile the batch and return the plan
 * instead of executing it. PostgreSQL's `EXPLAIN` does the same. But an
 * *actual* plan means the statement ran, and on PostgreSQL `EXPLAIN ANALYZE`
 * runs it for real — which for anything that writes is not what somebody
 * asking to see a plan meant. So a non-`SELECT` is wrapped in a transaction
 * that is rolled back, and the caller is expected to have said so first.
 */
export function wrapForPlan(driver: DriverKind, sql: string, mode: PlanMode, writes: boolean): string {
  if (mode === 'none') {
    return sql;
  }
  if (driver === 'mssql') {
    const setting = mode === 'actual' ? 'STATISTICS XML' : 'SHOWPLAN_XML';
    // `SHOWPLAN_XML` has to be the only statement in its batch, so the `GO`
    // separators are real and not decoration.
    return `SET ${setting} ON;\nGO\n${sql}\nGO\nSET ${setting} OFF;\n`;
  }
  const options =
    mode === 'actual' ? 'ANALYZE, BUFFERS, VERBOSE, COSTS, FORMAT JSON' : 'COSTS, VERBOSE, FORMAT JSON';
  const explained = `EXPLAIN (${options}) ${sql.trim().replace(/;\s*$/, '')}`;
  if (mode === 'actual' && writes) {
    // ANALYZE really runs it. A write gets a transaction it cannot escape.
    return `BEGIN;\n${explained};\nROLLBACK;`;
  }
  return explained;
}

/** Turns whatever the server returned into the one tree both engines share. */
export function parsePlan(driver: DriverKind, raw: string, actual: boolean): PlanPayload {
  try {
    const root = driver === 'mssql' ? parseShowplan(raw) : parseExplain(raw);
    return {
      root,
      raw: driver === 'mssql' ? raw : prettyJson(raw),
      stats: root ? summarise(root) : [],
      warnings: root ? collectWarnings(root) : [],
      actual
    };
  } catch (error) {
    return {
      root: null,
      raw,
      stats: [],
      warnings: [`The plan could not be read: ${error instanceof Error ? error.message : String(error)}`],
      actual
    };
  }
}

/* ------------------------------------------------------------- SQL Server */

function parseShowplan(xml: string): PlanNode | null {
  const document = parseXml(xml);
  if (!document) {
    return null;
  }
  const statements = descendants(document, 'StmtSimple');
  const statement = statements[0];
  if (!statement) {
    return null;
  }
  const queryPlan = firstNamed(statement, 'QueryPlan');
  const top = queryPlan ? firstNamed(queryPlan, 'RelOp') : undefined;

  let counter = 0;
  const build = (element: XmlElement): PlanNode => {
    const subtree = num(element.attributes.EstimatedTotalSubtreeCost) ?? 0;
    const children = relOpChildren(element).map(build);
    const own = Math.max(0, subtree - children.reduce((sum, child) => sum + child.cost, 0));
    const runtime = descendants(element, 'RunTimeCountersPerThread');
    const actualRows = runtime.length
      ? runtime.reduce((sum, thread) => sum + (num(thread.attributes.ActualRows) ?? 0), 0)
      : undefined;
    const executions = runtime.length
      ? runtime.reduce((sum, thread) => sum + (num(thread.attributes.ActualExecutions) ?? 0), 0)
      : undefined;

    return {
      id: `n${++counter}`,
      operation: element.attributes.PhysicalOp || 'Operator',
      detail: element.attributes.LogicalOp || undefined,
      object: objectName(element),
      // Held as an absolute cost here and normalised to a share once the root
      // is known, because a node cannot see the total from inside the walk.
      cost: own,
      estimatedRows: num(element.attributes.EstimateRows),
      actualRows,
      executions,
      warnings: showplanWarnings(element),
      children
    };
  };

  const root = top ? build(top) : null;
  if (!root) {
    return null;
  }
  const total = totalCost(root);
  normalise(root, total);
  const select: PlanNode = {
    id: 'n0',
    operation: statement.attributes.StatementType || 'SELECT',
    detail: undefined,
    object: undefined,
    cost: 0,
    warnings: [],
    children: [root]
  };
  return select;
}

/** The `RelOp` elements that are this operator's inputs, and not its grandchildren. */
function relOpChildren(element: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (child.name === 'RelOp') {
      out.push(child);
    } else if (child.name !== 'RunTimeInformation' && child.name !== 'Warnings') {
      out.push(...relOpChildren(child));
    }
  }
  return out;
}

function objectName(element: XmlElement): string | undefined {
  const object = descendants(element, 'Object')[0];
  if (!object) {
    return undefined;
  }
  const index = object.attributes.Index;
  const table = object.attributes.Table;
  const strip = (value?: string) => value?.replace(/^\[|\]$/g, '');
  return strip(index) ?? strip(table);
}

function showplanWarnings(element: XmlElement): string[] {
  const found: string[] = [];
  for (const warnings of childrenNamed(element, 'Warnings')) {
    if (warnings.attributes.NoJoinPredicate === 'true') {
      found.push('No join predicate — every row is compared with every row.');
    }
    for (const spill of childrenNamed(warnings, 'SpillToTempDb')) {
      found.push(`Spilled to tempdb at level ${spill.attributes.SpillLevel ?? '?'}.`);
    }
    for (const memory of childrenNamed(warnings, 'MemoryGrantWarning')) {
      found.push(`Memory grant warning: ${memory.attributes.GrantWarningKind ?? 'unspecified'}.`);
    }
    if (childrenNamed(warnings, 'PlanAffectingConvert').length) {
      found.push('An implicit conversion is stopping an index from being used.');
    }
  }
  return found;
}

/* ------------------------------------------------------------- PostgreSQL */

interface PgPlan {
  'Node Type'?: string;
  'Join Type'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Sort Method'?: string;
  Plans?: PgPlan[];
}

function parseExplain(raw: string): PlanNode | null {
  const parsed = JSON.parse(raw) as unknown;
  const first = Array.isArray(parsed) ? (parsed[0] as { Plan?: PgPlan } | undefined) : undefined;
  const top = first?.Plan;
  if (!top) {
    return null;
  }

  let counter = 0;
  const build = (plan: PgPlan): PlanNode => {
    const children = (plan.Plans ?? []).map(build);
    const total = plan['Total Cost'] ?? 0;
    const own = Math.max(0, total - (plan.Plans ?? []).reduce((sum, child) => sum + (child['Total Cost'] ?? 0), 0));
    const warnings: string[] = [];
    if (plan['Sort Method']?.startsWith('external')) {
      warnings.push(`Sort spilled to disk (${plan['Sort Method']}).`);
    }
    return {
      id: `n${++counter}`,
      operation: plan['Node Type'] ?? 'Node',
      detail: plan['Join Type'] ? `${plan['Join Type']} Join` : undefined,
      object: plan['Index Name'] ?? plan['Relation Name'],
      cost: own,
      estimatedRows: plan['Plan Rows'],
      actualRows: plan['Actual Rows'],
      executions: plan['Actual Loops'],
      warnings,
      children
    };
  };

  const root = build(top);
  normalise(root, totalCost(root));
  return root;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/* ---------------------------------------------------------------- shared */

function totalCost(node: PlanNode): number {
  return node.cost + node.children.reduce((sum, child) => sum + totalCost(child), 0);
}

/** Absolute costs become shares of the whole plan, which is what is drawn. */
function normalise(node: PlanNode, total: number): void {
  node.cost = total > 0 ? node.cost / total : 0;
  for (const child of node.children) {
    normalise(child, total);
  }
}

/**
 * The three warnings that explain most bad plans.
 *
 * They are computed here rather than taken from the server because neither
 * engine reports the first one at all: a plan built on an estimate that turned
 * out to be a thousand times wrong is a correct plan for a question nobody
 * asked, and only a comparison finds it.
 */
function collectWarnings(root: PlanNode): string[] {
  const out: string[] = [];
  const walk = (node: PlanNode) => {
    out.push(...node.warnings);

    const estimated = node.estimatedRows;
    const actual = node.actualRows;
    if (estimated !== undefined && actual !== undefined && actual >= 1000) {
      const ratio = actual / Math.max(estimated, 0.01);
      if (ratio >= 10 || ratio <= 0.1) {
        out.push(
          `${node.operation} expected ${format(estimated)} rows and got ${format(actual)}. Statistics are out of date, or the predicate is not sargable.`
        );
      }
    }

    if (/(Table Scan|Clustered Index Scan|Seq Scan)/i.test(node.operation) && node.cost >= 0.25) {
      out.push(`${node.operation}${node.object ? ` on ${node.object}` : ''} is ${Math.round(node.cost * 100)}% of the plan.`);
    }

    if (/Key Lookup|RID Lookup/i.test(node.operation) && (node.executions ?? 0) > 100) {
      out.push(
        `${node.operation} ran ${format(node.executions ?? 0)} times. A covering index removes it.`
      );
    }

    node.children.forEach(walk);
  };
  walk(root);
  return [...new Set(out)];
}

function summarise(root: PlanNode): { label: string; value: string }[] {
  let operators = 0;
  let rows = 0;
  const walk = (node: PlanNode) => {
    operators++;
    rows += node.actualRows ?? 0;
    node.children.forEach(walk);
  };
  walk(root);
  return [
    { label: 'Operators', value: String(operators) },
    { label: 'Rows read', value: format(rows) }
  ];
}

function format(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
