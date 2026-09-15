import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aliasFor } from './alias';

describe('aliasFor', () => {
  it('reads the capitals of a camel-cased name, without its prefix', () => {
    assert.equal(aliasFor('empManualAttendanceSummary'), 'mas');
    assert.equal(aliasFor('SalesOrderHeader'), 'soh');
  });

  it('reads the first letters of a snake-cased name', () => {
    assert.equal(aliasFor('sales_order_line'), 'sol');
  });

  it('falls back to the first three letters', () => {
    assert.equal(aliasFor('Customers'), 'cus');
    assert.equal(aliasFor('SALESORDER'), 'sal');
  });

  it('numbers a second copy of the same table', () => {
    assert.equal(aliasFor('Users', ['usr']), 'usr2');
    assert.equal(aliasFor('Customers', ['cus', 'cus2']), 'cus3');
  });

  it('never produces a keyword', () => {
    assert.equal(aliasFor('Users'), 'usr');
    assert.equal(aliasFor('OrderNumber'), 'ord');
    assert.equal(aliasFor('Endpoints'), 'endp');
    assert.equal(aliasFor('Keys'), 'kys');
    assert.equal(aliasFor('Sets'), 'sts');
  });

  it('strips brackets and quotes', () => {
    assert.equal(aliasFor('[Order Details]'), 'od');
    assert.equal(aliasFor('"LeavePolicy"'), 'lp');
  });
});
