/**
 * The text of a routine call, written the way a person would write it.
 *
 * Nothing here imports `vscode`, so the shape of what gets inserted can be
 * reasoned about — and checked — as plain strings. The providers decide when
 * a call is written; this decides what it says.
 *
 * SQL Server and PostgreSQL call routines differently enough that the two are
 * separate statements rather than one with different punctuation:
 *
 *   EXEC dbo.usp_GetCustomer @CustomerId = 1, @Name = N'Ada';
 *   CALL public.get_customer(p_customer_id => 1, p_name => 'Ada');
 *
 * SQL Server's arguments are named after their parameters, so leaving out an
 * optional one is just not writing it. PostgreSQL's are positional unless the
 * call uses named notation, and named notation is what lets an optional
 * argument in the middle be skipped — so it is used whenever every parameter
 * has a name to use.
 */
import { DbMember } from '../../shared/catalog';
import { DriverKind } from '../../types';

/** Which arguments an accepted procedure brings with it. */
export type ArgumentMode = 'required' | 'all' | 'none';

/** More arguments than this and the call goes one per line. */
const INLINE_MAX = 3;

export interface CallText {
  /** Snippet syntax: `${1:NULL}` placeholders, `\t` for one indent. */
  snippet: string;
  /**
   * `DECLARE` lines the call needs before it, one per output parameter.
   *
   * A SQL Server `OUTPUT` argument has to be a variable. Writing one the
   * script has never declared is a call that fails with `Must declare the
   * scalar variable`, which is the error this exists to prevent.
   */
  declarations: string[];
}

/** The arguments that take part in a call at all: never the return value. */
export function parametersOf(members: DbMember[]): DbMember[] {
  return members.filter((member) => member.direction !== 'returns');
}

export function isOutput(parameter: DbMember): boolean {
  return parameter.direction === 'out' || parameter.direction === 'inout';
}

/**
 * The argument list that follows a routine's name.
 *
 * `declared` holds the lower-cased names of variables the document already
 * declares, so a second call to the same procedure does not declare `@Total`
 * twice.
 */
export function callText(
  driver: DriverKind,
  members: DbMember[],
  mode: ArgumentMode,
  declared: ReadonlySet<string> = new Set()
): CallText {
  const parameters = parametersOf(members);
  return driver === 'postgres' ? postgresCall(parameters, mode) : mssqlCall(parameters, mode, declared);
}

function mssqlCall(parameters: DbMember[], mode: ArgumentMode, declared: ReadonlySet<string>): CallText {
  const chosen = choose(parameters, mode);
  if (chosen.length === 0) {
    return { snippet: '', declarations: [] };
  }

  const declarations: string[] = [];
  let stop = 0;
  const args = chosen.map((parameter) => {
    if (isOutput(parameter)) {
      if (!declared.has(parameter.name.toLowerCase())) {
        declarations.push(declaration(parameter));
      }
      return argumentText('mssql', parameter, stop);
    }
    return argumentText('mssql', parameter, ++stop);
  });

  const snippet =
    args.length > INLINE_MAX ? `\n\t${args.join(',\n\t')}` : ` ${args.join(', ')}`;
  return { snippet: `${snippet}$0`, declarations };
}

function postgresCall(parameters: DbMember[], mode: ArgumentMode): CallText {
  // Named notation needs a name for every argument it writes, and an unnamed
  // one leaves only positions — in which case nothing before the last required
  // argument can be skipped, so everything up to it is written.
  const named = parameters.every((parameter) => parameter.name);
  let chosen: DbMember[];
  if (mode === 'none') {
    chosen = [];
  } else if (named) {
    chosen = choose(parameters, mode);
  } else {
    const last = mode === 'all' ? parameters.length : lastRequired(parameters) + 1;
    chosen = parameters.slice(0, last);
  }

  let stop = 0;
  const args = chosen.map((parameter) => argumentText('postgres', parameter, ++stop, named));
  // The parentheses are not optional in PostgreSQL, even around nothing.
  if (args.length === 0) {
    return { snippet: '($0)', declarations: [] };
  }
  const snippet =
    args.length > INLINE_MAX ? `(\n\t${args.join(',\n\t')}\n)` : `(${args.join(', ')})`;
  return { snippet: `${snippet}$0`, declarations: [] };
}

/**
 * One argument, as snippet text: `@CustomerId = ${1:NULL}`, `p_id => ${1:NULL}`.
 *
 * A SQL Server output parameter is passed a variable of its own name rather
 * than a placeholder, because nothing but a variable can go there. The caller
 * is responsible for its `DECLARE`.
 */
export function argumentText(driver: DriverKind, parameter: DbMember, stop: number, named = true): string {
  const name = escape(parameter.name);
  if (driver === 'mssql') {
    return isOutput(parameter)
      ? `${name} = ${name} OUTPUT`
      : `${name} = ${placeholder('mssql', parameter, stop)}`;
  }
  const value = placeholder('postgres', parameter, stop);
  return named ? `${name} => ${value}` : value;
}

/** `DECLARE @Total int;`, for a SQL Server output parameter. */
export function declaration(parameter: DbMember): string {
  return `DECLARE ${parameter.name} ${parameter.type};`;
}

/**
 * The variables a script already declares, lower-cased.
 *
 * Read from `DECLARE` statements and their continuation lines, which is enough
 * to stop a second call from declaring `@Total` twice. It is a courtesy, not a
 * scope analysis: a variable it misses is declared again and the server says
 * so, on the line that did it.
 */
export function declaredVariables(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/\bDECLARE\s+((?:[^;\n]|\n(?=\s*[@,]))*)/gi)) {
    for (const piece of match[1].split(',')) {
      const variable = /^(@[\w@#$]+)\s+(?![=\s])/.exec(piece.trim());
      if (variable) {
        names.add(variable[1].toLowerCase());
      }
    }
  }
  return names;
}

/**
 * The parameters a call writes out.
 *
 * `required` means those without a default, and a procedure's output
 * parameters on PostgreSQL, which have to be passed even though nothing is
 * passed in them.
 */
function choose(parameters: DbMember[], mode: ArgumentMode): DbMember[] {
  if (mode === 'none') {
    return [];
  }
  if (mode === 'all') {
    return parameters;
  }
  return parameters.filter((parameter) => parameter.default === undefined);
}

function lastRequired(parameters: DbMember[]): number {
  for (let i = parameters.length - 1; i >= 0; i--) {
    if (parameters[i].default === undefined) {
      return i;
    }
  }
  return -1;
}

/**
 * What stands in for a value until one is typed.
 *
 * Text types arrive with their quotes and the caret between them, because the
 * quotes are the keystrokes everybody makes and nobody thinks about. Everything
 * else is `NULL`, selected, so the first key typed replaces it — and a call run
 * without anything typed passes nothing rather than a zero that looks real.
 *
 * An optional parameter written anyway stands on its default: `DEFAULT` in
 * SQL Server, which the server resolves itself, and the declared expression in
 * PostgreSQL, where a call has no keyword for it.
 */
export function placeholder(driver: DriverKind, parameter: DbMember, stop: number): string {
  if (parameter.default !== undefined) {
    const value = driver === 'mssql' ? 'DEFAULT' : parameter.default;
    return `\${${stop}:${escape(value)}}`;
  }
  if (driver === 'postgres' && parameter.direction === 'out') {
    return `\${${stop}:NULL}`;
  }
  const type = parameter.type.toLowerCase();
  if (/^n(var)?char|^ntext/.test(type) && driver === 'mssql') {
    return `N'\${${stop}}'`;
  }
  if (QUOTED.test(type)) {
    return `'\${${stop}}'`;
  }
  return `\${${stop}:NULL}`;
}

const QUOTED =
  /^(var)?char|^character|^text|^sysname|^citext|^uuid|^uniqueidentifier|^date|^time|^smalldatetime|^interval|^json|^xml/;

/** Snippet syntax treats these three as markup, so literal text escapes them. */
function escape(text: string): string {
  return text.replace(/[\\$}]/g, (ch) => `\\${ch}`);
}

/* ------------------------------------------------------------- signatures */

export interface SignatureText {
  label: string;
  /** Each parameter's `[start, end)` within `label`, in declaration order. */
  spans: Array<[number, number]>;
}

/**
 * One line that reads like the declaration: what the parameter is called, what
 * it takes, whether it can be left out and whether it comes back.
 *
 *   dbo.usp_GetCustomer @CustomerId int, @Name nvarchar(50) = NULL, @Total int OUTPUT
 *   public.get_customer(p_id integer, p_limit integer DEFAULT 10)
 */
export function signatureText(driver: DriverKind, qualifiedName: string, members: DbMember[]): SignatureText {
  const parameters = parametersOf(members);
  const spans: Array<[number, number]> = [];
  let label = driver === 'postgres' ? `${qualifiedName}(` : `${qualifiedName} `;
  parameters.forEach((parameter, i) => {
    if (i > 0) {
      label += ', ';
    }
    const start = label.length;
    label += parameterText(driver, parameter);
    spans.push([start, label.length]);
  });
  if (driver === 'postgres') {
    label += ')';
  }
  return { label: label.trimEnd(), spans };
}

export function parameterText(driver: DriverKind, parameter: DbMember): string {
  const name = parameter.name ? `${parameter.name} ` : '';
  if (driver === 'postgres') {
    const mode = parameter.direction === 'out' ? 'OUT ' : parameter.direction === 'inout' ? 'INOUT ' : '';
    const fallback = parameter.default !== undefined ? ` DEFAULT ${parameter.default}` : '';
    return `${mode}${name}${parameter.type}${fallback}`;
  }
  const fallback = parameter.default !== undefined ? ` = ${parameter.default}` : '';
  return `${name}${parameter.type}${fallback}${isOutput(parameter) ? ' OUTPUT' : ''}`;
}

/** The short note a parameter carries in a list: `required`, `= NULL`, `OUTPUT`. */
export function parameterNote(driver: DriverKind, parameter: DbMember): string {
  const notes: string[] = [];
  if (isOutput(parameter)) {
    notes.push(driver === 'postgres' && parameter.direction === 'inout' ? 'INOUT' : 'OUTPUT');
  }
  notes.push(parameter.default !== undefined ? `default ${parameter.default}` : 'required');
  return notes.join(' · ');
}
