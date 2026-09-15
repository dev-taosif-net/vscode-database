import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyse } from './context';

/** `analyse` at the `|` in `sql`, with the bar taken out. */
function at(sql: string) {
  return analyse(sql.replace('|', ''), sql.indexOf('|'));
}

function aliases(sql: string): string[] {
  return at(sql).relations.map((relation) => relation.as);
}

describe('statement scope', () => {
  it('ends a statement at a semicolon', () => {
    assert.deepEqual(aliases('SELECT * FROM a x; SELECT * FROM b y WHERE |'), ['y']);
  });

  it('ends a statement where the next one begins, with no semicolon', () => {
    assert.deepEqual(
      aliases('SELECT * FROM saas.empEmployeeBasicInfo ebi \nSELECT * FROM saas.empEmployeeBasicInfoDetails ebid WHERE ebi|'),
      ['ebid']
    );
    assert.deepEqual(aliases('SELECT * FROM a\nDELETE FROM b WHERE |'), ['b']);
    assert.deepEqual(aliases('SELECT * FROM z zz\nIF EXISTS (SELECT 1 FROM a x WHERE |'), ['x']);
  });

  it('keeps the caret in the first statement when it is there', () => {
    assert.deepEqual(aliases('SELECT * FROM a x WHERE x.|\nSELECT * FROM b y'), ['x']);
  });

  it('reads the FROM written after the caret', () => {
    assert.deepEqual(aliases('SELECT * FROM a x\nSELECT y.| FROM b y'), ['y']);
  });

  it('treats a UNION as one statement', () => {
    assert.deepEqual(aliases('SELECT * FROM a x UNION ALL SELECT * FROM b y WHERE |'), ['x', 'y']);
  });

  it('keeps the outer relations inside a subquery', () => {
    assert.deepEqual(aliases('SELECT * FROM a x WHERE x.id IN (SELECT id FROM b y WHERE |'), ['x', 'y']);
  });

  it('does not see into a subquery that has closed', () => {
    assert.deepEqual(aliases('SELECT * FROM a x WHERE x.id IN (SELECT id FROM b y) AND |'), ['x']);
  });

  it('reads INSERT … SELECT as one statement and INSERT … VALUES as finished', () => {
    assert.deepEqual(aliases('INSERT INTO t (a) SELECT a FROM s ss WHERE |'), ['t', 'ss']);
    assert.deepEqual(aliases('INSERT INTO t (a) VALUES (1)\nSELECT * FROM s ss WHERE |'), ['ss']);
  });

  it('reads UPDATE … FROM', () => {
    assert.deepEqual(aliases('UPDATE x SET x.a = 1 FROM a x JOIN b y ON |'), ['x', 'x', 'y']);
  });

  it('leaves a table hint alone', () => {
    assert.deepEqual(aliases('SELECT * FROM a x WITH (NOLOCK) JOIN b y ON |'), ['x', 'y']);
  });
});

describe('aliases', () => {
  it('does not read a statement word as an alias', () => {
    const context = at('SELECT * FROM a\nSELECT |');
    assert.deepEqual(context.relations.map((relation) => relation.as), []);
  });

  it('does not put the word being typed in scope', () => {
    assert.deepEqual(aliases('SELECT * FROM a x JOIN Ord|'), ['x']);
    assert.deepEqual(aliases('SELECT * FROM Users|'), []);
  });

  it('reads the alias after a table-valued function', () => {
    assert.deepEqual(aliases('SELECT * FROM a x CROSS APPLY dbo.fn(x.id) f WHERE |'), ['x', 'f']);
  });

  it('does not offer a database list after an alias that is a keyword', () => {
    assert.equal(at('SELECT * FROM auth.Users usr |').wantsDatabase, false);
    assert.equal(at('USE |').wantsDatabase, true);
  });
});

describe('local relations', () => {
  it('reads a CTE and its columns', () => {
    const context = at('WITH c AS (SELECT a, b.x AS y, COUNT(*) n FROM t b) SELECT * FROM c WHERE |');
    // `x` belongs to the CTE's body, which has closed; only `c` is in scope.
    assert.deepEqual(aliases('WITH c AS (SELECT * FROM a x) SELECT * FROM c WHERE |'), ['c']);
    const cte = context.relations.find((relation) => relation.as === 'c');
    assert.deepEqual(cte?.columns?.map((column) => column.name), ['a', 'y', 'n']);
  });

  it('reads a CTE with an explicit column list', () => {
    const context = at('WITH c (p, q) AS (SELECT 1, 2) SELECT c.| FROM c');
    assert.deepEqual(context.relations[0].columns?.map((column) => column.name), ['p', 'q']);
  });

  it('reads a derived table and hides what is inside it', () => {
    const context = at('SELECT * FROM (SELECT id, name FROM a x) d WHERE |');
    assert.deepEqual(context.relations.map((relation) => relation.as), ['d']);
    assert.deepEqual(context.relations[0].columns?.map((column) => column.name), ['id', 'name']);
  });

  it('reads the inner FROM while a derived table is still open', () => {
    assert.deepEqual(aliases('SELECT * FROM (SELECT * FROM a x WHERE |'), ['x']);
  });

  it('reads a temp table from CREATE TABLE', () => {
    const context = at('CREATE TABLE #t (Id int NOT NULL, Amount decimal(18, 2), CONSTRAINT pk PRIMARY KEY (Id))\nSELECT * FROM #t WHERE |');
    assert.deepEqual(context.relations[0].columns, [
      { name: 'Id', type: 'int' },
      { name: 'Amount', type: 'decimal(18,2)' }
    ]);
  });

  it('reads a table variable', () => {
    const context = at('DECLARE @t TABLE (a int, b nvarchar(50))\nSELECT * FROM @t WHERE |');
    assert.deepEqual(context.relations[0].columns?.map((column) => column.name), ['a', 'b']);
  });

  it('reads SELECT … INTO', () => {
    const context = at('SELECT x.id, x.name INTO #t FROM a x\nSELECT * FROM #t WHERE |');
    assert.deepEqual(context.relations[0].columns?.map((column) => column.name), ['id', 'name']);
  });

  it('does not mistake INSERT INTO or MERGE INTO for SELECT INTO', () => {
    const context = at('SELECT 1\nMERGE INTO t USING s ON 1 = 1\nSELECT * FROM t WHERE |');
    assert.equal(context.relations[0].columns, undefined);
  });
});

describe('select list', () => {
  it('knows what the query selects, for ORDER BY', () => {
    assert.deepEqual(at('SELECT a.id, a.name AS n, COUNT(*) cnt FROM a GROUP BY a.id ORDER BY |').selected, ['id', 'n', 'cnt']);
  });

  it('skips DISTINCT and TOP', () => {
    assert.deepEqual(at('SELECT DISTINCT TOP 10 a.id FROM a ORDER BY |').selected, ['id']);
    assert.deepEqual(at('SELECT TOP (@n) PERCENT a.id FROM a ORDER BY |').selected, ['id']);
  });
});

describe('insert shape', () => {
  it('knows the caret is in the column list, and what is listed', () => {
    const context = at('INSERT INTO t (a, b|');
    assert.deepEqual(context.insert, { columns: ['a'], inColumns: true, atRow: false });
  });

  it('knows the caret is at the start of a values row', () => {
    assert.equal(at('INSERT INTO t (a, b) VALUES (|').insert?.atRow, true);
    assert.equal(at('INSERT INTO t (a, b) VALUES (1, 2), (|').insert?.atRow, true);
    assert.equal(at('INSERT INTO t VALUES (|').insert?.atRow, true);
    assert.equal(at('INSERT INTO t (a, b) VALUES (1, |').insert?.atRow, false);
  });

  it('is not fooled by a table hint', () => {
    assert.deepEqual(at('INSERT INTO t WITH (TABLOCK) (a|').insert, { columns: [], inColumns: true, atRow: false });
  });
});

describe('function calls', () => {
  it('knows the call and the argument', () => {
    assert.deepEqual(at('SELECT DATEADD(day, |').func, { name: 'DATEADD', argument: 1 });
    assert.deepEqual(at('SELECT DATEADD(day, 1, GETDATE()) FROM t WHERE ISNULL(|').func, { name: 'ISNULL', argument: 0 });
    assert.equal(at('SELECT DATEADD(day, 1, x) |').func, undefined);
  });
});

describe('qualifier and prefix', () => {
  it('reads the alias before a dot', () => {
    const context = at('SELECT * FROM a x WHERE x.na|');
    assert.equal(context.qualifier, 'x');
    assert.equal(context.prefix, 'na');
  });

  it('reads a bracketed name whole', () => {
    const context = at('SELECT * FROM [Order Details] od WHERE od.[Unit|');
    assert.equal(context.qualifier, 'od');
    assert.equal(context.prefix, '[Unit');
  });

  it('ignores a word after the caret', () => {
    assert.equal(at('SELECT * FROM a x WHERE x.na|me').prefix, 'na');
  });

  it('sees inside a CASE', () => {
    assert.equal(at('SELECT CASE WHEN a = 1 THEN |').inCase, true);
    assert.equal(at('SELECT CASE WHEN a = 1 THEN 2 END, |').inCase, false);
  });
});
