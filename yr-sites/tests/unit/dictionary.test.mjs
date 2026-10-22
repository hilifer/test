// Module: shared/dictionary.js — the unified status language. IDs DI-xx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT, label, canMove, nextStates } from '../../shared/dictionary.js';

const machines = ['quote', 'order', 'shipment', 'rma'];

test('DI-01a every transition starts and ends in a defined state', () => {
  for (const m of machines) {
    const states = Object.keys(DICT[m].states);
    for (const [from, tos] of Object.entries(DICT[m].transitions)) {
      assert.ok(states.includes(from), `${m}.${from}`);
      for (const to of tos) assert.ok(states.includes(to), `${m}: ${from} → ${to}`);
    }
  }
});
test('DI-01b every state has a transition entry', () => {
  for (const m of machines) {
    const states = Object.keys(DICT[m].states);
    for (const s of states) assert.ok(s in DICT[m].transitions, `${m}.${s} has no transition entry`);
  }
});
test('DI-02 every state has zh + en labels', () => {
  for (const m of machines) for (const [s, l] of Object.entries(DICT[m].states)) { assert.ok(l.zh, `${m}.${s}.zh`); assert.ok(l.en, `${m}.${s}.en`); }
});
test('DI-03 terminal states cannot move', () => {
  assert.deepEqual(nextStates('order', 'completed'), []);
  assert.deepEqual(nextStates('order', 'cancelled'), []);
  assert.deepEqual(nextStates('quote', 'accepted'), []);
  assert.deepEqual(nextStates('rma', 'resolved'), []);
});
test('DI-04a an order goes into production before it can ship', () => {
  assert.equal(canMove('order', 'awaiting_deposit', 'in_production'), true);
  assert.equal(canMove('order', 'awaiting_deposit', 'shipped'), false, 'cannot ship before production');
});
test('DI-04b a shipped order cannot be cancelled', () => {
  assert.equal(canMove('order', 'shipped', 'cancelled'), false, 'cannot cancel after shipping');
});
test('DI-04c only a sent quote (not a draft) can be accepted', () => {
  assert.equal(canMove('quote', 'sent', 'accepted'), true);
  assert.equal(canMove('quote', 'draft', 'accepted'), false, 'customer cannot accept a draft');
});
test('DI-04d a shipment in exception can still be delivered', () => {
  assert.equal(canMove('shipment', 'exception', 'delivered'), true);
});
test('DI-04e a rejected RMA can be reopened for review', () => {
  assert.equal(canMove('rma', 'rejected', 'reviewing'), true, 'rejected cases can be reopened');
});
test('DI-05 numbering prefixes are unique', () => {
  const p = machines.map((m) => DICT[m].prefix);
  assert.equal(new Set(p).size, p.length);
});
test('DI-06 order timeline is an ordered path through allowed transitions', () => {
  const tl = DICT.order.timeline;
  for (let i = 1; i < tl.length; i++) assert.ok(canMove('order', tl[i - 1], tl[i]), `${tl[i - 1]} → ${tl[i]}`);
});
test('DI-07a label returns the Chinese label by default', () => {
  assert.equal(label('order', 'in_production'), '生产/备货中');
});
test('DI-07b label returns the English label when asked', () => {
  assert.equal(label('order', 'in_production', 'en'), 'In production');
});
test('DI-07c label falls back to the raw code for an unknown state or machine', () => {
  assert.equal(label('order', 'weird'), 'weird');
  assert.equal(label('nope', 'x'), 'x');
});
test('DI-08a the payment terms are defined', () => {
  assert.deepEqual(DICT.paymentTerms.map((t) => t.id), ['tt30', 'tt100', 'tt30bl', 'lc']);
});
test('DI-08b the incoterms include FOB and DDP', () => {
  assert.ok(DICT.incoterms.includes('FOB') && DICT.incoterms.includes('DDP'));
});
