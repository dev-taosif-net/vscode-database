import { DbMember, FavouriteRef } from '../shared/catalog';
import { RunnerControl, RunnerForm, RunnerParameter, RunnerValue } from '../shared/query';
import { DriverKind } from '../types';

/**
 * The execution form, generated from the parameter list the catalog already
 * returns.
 *
 * The control is chosen by type, and one detail carries most of the value: a
 * nullable parameter gets a NULL checkbox of its own. An empty string and a
 * NULL are different arguments, and a form that cannot express the difference
 * cannot call half the procedures in an estate.
 */
export function buildForm(
  ref: FavouriteRef,
  members: DbMember[],
  values: Record<string, RunnerValue>
): RunnerForm {
  const parameters = members
    .filter((member) => member.direction !== 'returns')
    .map<RunnerParameter>((member) => {
      const nullable = member.nullable !== false;
      return {
        name: member.name,
        label: humanise(member.name),
        type: member.type,
        control: controlFor(member.type),
        nullable,
        // A parameter with a default is not required: pressing Execute without
        // touching it does what calling the routine with no arguments does.
        required: !nullable && member.direction !== 'out',
        direction: member.direction === 'out' ? 'out' : member.direction === 'inout' ? 'inout' : 'in'
      };
    });
  return { ref, parameters, values };
}

function controlFor(type: string): RunnerControl {
  const t = type.toLowerCase();
  if (/^(bit|bool)/.test(t)) {
    return 'bool';
  }
  if (/(int|decimal|numeric|money|float|real|double)/.test(t)) {
    return 'number';
  }
  if (/(date|time)/.test(t)) {
    return 'date';
  }
  if (/(max\)|text|xml|json)/.test(t)) {
    return 'multiline';
  }
  return 'text';
}

/** `@CustomerId` becomes `Customer Id`; `p_order_no` becomes `Order No`. */
function humanise(name: string): string {
  return name
    .replace(/^[@:$]/, '')
    .replace(/^p_/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export interface Call {
  sql: string;
  params: unknown[];
  /** The text shown in the preview, with the values as comments beside them. */
  preview: string;
}

/**
 * The statement a run sends.
 *
 * Values are bound, never concatenated, and the preview says so. Two things
 * follow from binding that a string-building runner cannot offer: a value
 * containing a quote is an ordinary value rather than a syntax error, and the
 * statement in the preview is exactly the statement that runs.
 *
 * SQL Server gets the longer form because it is the only way to see an output
 * parameter or a return value: both need declaring, both need `OUTPUT` on the
 * call, and both need selecting afterwards. A runner that showed only the grid
 * would lose half the answer on a procedure that has either.
 */
export function buildCall(
  driver: DriverKind,
  ref: FavouriteRef,
  parameters: RunnerParameter[],
  values: Record<string, RunnerValue>
): Call {
  const params: unknown[] = [];
  const target = `${quote(driver, ref.schema)}.${quote(driver, ref.name)}`;

  const bind = (parameter: RunnerParameter): string => {
    const value = values[parameter.name];
    params.push(value && !value.null ? value.text : null);
    return driver === 'mssql' ? `@p${params.length - 1}` : `$${params.length}`;
  };

  const comment = (parameter: RunnerParameter): string => {
    const value = values[parameter.name];
    return value && !value.null ? value.text : 'NULL';
  };

  if (driver === 'postgres') {
    const inputs = parameters.filter((parameter) => parameter.direction !== 'out');
    const marks = inputs.map(bind);
    const call =
      ref.kind === 'procedure'
        ? `CALL ${target}(${marks.join(', ')});`
        : `SELECT * FROM ${target}(${marks.join(', ')});`;
    const preview = inputs.length
      ? `${call.replace(/\($/, '(')}\n${inputs
          .map((parameter, index) => `-- ${marks[index]} = ${parameter.name}: ${comment(parameter)}`)
          .join('\n')}`
      : call;
    return { sql: call, params, preview };
  }

  const declarations: string[] = [];
  const arguments_: string[] = [];
  const selections: string[] = [];

  for (const parameter of parameters) {
    const local = `@${parameter.name.replace(/^@/, '')}_out`;
    if (parameter.direction === 'in') {
      arguments_.push(`${withAt(parameter.name)} = ${bind(parameter)}`);
      continue;
    }
    declarations.push(`DECLARE ${local} ${parameter.type};`);
    if (parameter.direction === 'inout') {
      declarations.push(`SET ${local} = ${bind(parameter)};`);
    }
    arguments_.push(`${withAt(parameter.name)} = ${local} OUTPUT`);
    selections.push(`${local} AS ${quote('mssql', parameter.name.replace(/^@/, ''))}`);
  }

  const head = declarations.length ? `${declarations.join('\n')}\nDECLARE @__return int;\n` : 'DECLARE @__return int;\n';
  const call = `EXEC @__return = ${target}${arguments_.length ? `\n     ${arguments_.join(',\n     ')}` : ''};`;
  const tail = `\nSELECT ${['@__return AS [Return value]', ...selections].join(', ')};`;

  const preview =
    `${head}${call}${tail}\n` +
    parameters
      .filter((parameter) => parameter.direction !== 'out')
      .map((parameter) => `-- ${withAt(parameter.name)} = ${comment(parameter)}`)
      .join('\n');

  return { sql: `${head}${call}${tail}`, params, preview };
}

function withAt(name: string): string {
  return name.startsWith('@') ? name : `@${name}`;
}

function quote(driver: DriverKind, name: string): string {
  return driver === 'mssql' ? `[${name.replace(/]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
}
