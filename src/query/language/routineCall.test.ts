import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { builtinSignature } from './builtins';
import { declaredVariableTypes, declaredVariables } from './routineCall';

describe('declaredVariableTypes', () => {
  it('reads one DECLARE with several variables, defaults left off', () => {
    const variables = declaredVariableTypes('DECLARE @Id int = 5, @Name nvarchar(50) = N\'x\', @Amount decimal(18, 2)');
    assert.deepEqual([...variables.values()], [
      { name: '@Id', type: 'int' },
      { name: '@Name', type: 'nvarchar(50)' },
      { name: '@Amount', type: 'decimal(18, 2)' }
    ]);
  });

  it('reads a DECLARE continued on the next line', () => {
    const variables = declaredVariableTypes('DECLARE @a int,\n  @b bit;\nSELECT 1');
    assert.deepEqual([...variables.keys()], ['@a', '@b']);
  });

  it('keeps the lower-cased set the call writer uses', () => {
    assert.deepEqual([...declaredVariables('DECLARE @Total int')], ['@total']);
  });
});

describe('builtinSignature', () => {
  it('labels a fixed function with a span per parameter', () => {
    const signature = builtinSignature('mssql', 'DATEADD');
    assert.equal(signature?.label, 'DATEADD(datepart, number, date)');
    assert.deepEqual(signature?.spans, [[8, 16], [18, 24], [26, 30]]);
    assert.equal(signature?.variadic, false);
  });

  it('marks a variadic function', () => {
    const signature = builtinSignature('postgres', 'COALESCE');
    assert.equal(signature?.label, 'COALESCE(expression, …)');
    assert.equal(signature?.variadic, true);
  });

  it('keeps each engine to its own functions', () => {
    assert.equal(builtinSignature('postgres', 'DATEADD'), undefined);
    assert.equal(builtinSignature('mssql', 'DATE_TRUNC'), undefined);
    assert.ok(builtinSignature('mssql', 'COALESCE'));
  });
});
