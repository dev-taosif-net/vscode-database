/**
 * The defaults a T-SQL routine declares, read out of its own header.
 *
 * `sys.parameters.has_default_value` is only ever set for CLR routines. For a
 * T-SQL procedure SQL Server keeps no record of which parameters are optional
 * anywhere but the text of the `CREATE`, which is why SSMS and every tool after
 * it reads the definition. So does this.
 *
 * It reads the header and stops: from the routine's name to the first `AS`,
 * `WITH`, `FOR` or `RETURNS` outside parentheses. Everything the body does is
 * irrelevant, and a scanner that stops early cannot be confused by it.
 */

const HEADER_END = new Set(['AS', 'WITH', 'FOR', 'RETURNS']);
const TRAILERS = new Set(['OUT', 'OUTPUT', 'READONLY']);

interface Piece {
  text: string;
  upper: string;
  /** Punctuation, a word, or a literal — a string, number or quoted name. */
  kind: 'punct' | 'word' | 'literal';
}

/** Lower-cased parameter name, `@` included, to its default expression. */
export function parameterDefaults(definition: string): Map<string, string> {
  const defaults = new Map<string, string>();
  const pieces = scan(definition);

  // `CREATE [OR ALTER] PROC[EDURE] | FUNCTION <name>`, where the name is one to
  // three dotted parts.
  let i = pieces.findIndex((p) => p.upper === 'PROC' || p.upper === 'PROCEDURE' || p.upper === 'FUNCTION');
  if (i < 0) {
    return defaults;
  }
  i++;
  while (i < pieces.length && (pieces[i].kind !== 'punct' || pieces[i].text === '.')) {
    if (pieces[i].kind === 'word' && pieces[i].text.startsWith('@')) {
      break;
    }
    if (pieces[i].kind === 'word' && HEADER_END.has(pieces[i].upper)) {
      return defaults;
    }
    i++;
  }

  // The list may or may not be wrapped in parentheses, and a type's own
  // parentheses — `nvarchar(50)`, `decimal(18, 2)` — sit one level inside it.
  const wrapped = pieces[i]?.kind === 'punct' && pieces[i].text === '(';
  const base = wrapped ? 1 : 0;
  let depth = base;
  if (wrapped) {
    i++;
  }
  let segment: Piece[] = [];
  const flush = () => {
    const name = segment[0];
    const equals = segment.findIndex((p) => p.text === '=');
    if (name?.text.startsWith('@') && equals > 0) {
      let end = segment.length;
      while (end > equals + 1 && segment[end - 1].kind === 'word' && TRAILERS.has(segment[end - 1].upper)) {
        end--;
      }
      const value = join(segment.slice(equals + 1, end));
      if (value) {
        defaults.set(name.text.toLowerCase(), value);
      }
    }
    segment = [];
  };

  for (; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece.kind === 'punct' && piece.text === '(') {
      depth++;
    } else if (piece.kind === 'punct' && piece.text === ')') {
      if (--depth < base) {
        break;
      }
    } else if (piece.kind === 'punct' && piece.text === ',' && depth === base) {
      flush();
      continue;
    } else if (depth === 0 && piece.kind === 'word' && HEADER_END.has(piece.upper)) {
      break;
    }
    segment.push(piece);
  }
  flush();
  return defaults;
}

/** Pieces back into source text, spaced the way a default is usually written. */
function join(pieces: Piece[]): string {
  let out = '';
  for (const piece of pieces) {
    const glue = out && !/[(.]$/.test(out) && !/^[),.]/.test(piece.text) ? ' ' : '';
    out += glue + piece.text;
  }
  // `- 1` is how a negative number comes back from a scanner that splits signs.
  return out.replace(/^([-+]) (?=\d)/, '$1');
}

function scan(text: string): Piece[] {
  const pieces: Piece[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (ch === "'" || ((ch === 'N' || ch === 'n') && text[i + 1] === "'")) {
      let j = text.indexOf("'", i) + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) {
        j += text[j] === "'" ? 2 : 1;
      }
      const end = Math.min(j + 1, text.length);
      pieces.push({ text: text.slice(i, end), upper: '', kind: 'literal' });
      i = end;
    } else if (ch === '[' || ch === '"') {
      const end = text.indexOf(ch === '[' ? ']' : '"', i + 1);
      const stop = end < 0 ? text.length : end + 1;
      pieces.push({ text: text.slice(i, stop), upper: '', kind: 'literal' });
      i = stop;
    } else if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?(e[-+]?[0-9]+)?/i.exec(text.slice(i));
      const length = match?.[0].length ?? 1;
      pieces.push({ text: text.slice(i, i + length), upper: '', kind: 'literal' });
      i += length;
    } else if (/[A-Za-z_@#]/.test(ch)) {
      const match = /^[A-Za-z_@#][A-Za-z0-9_@#$]*/.exec(text.slice(i));
      const length = match?.[0].length ?? 1;
      const word = text.slice(i, i + length);
      pieces.push({ text: word, upper: word.toUpperCase(), kind: 'word' });
      i += length;
    } else {
      pieces.push({ text: ch, upper: ch, kind: 'punct' });
      i++;
    }
  }
  return pieces;
}
