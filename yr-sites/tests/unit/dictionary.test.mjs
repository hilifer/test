// Module: shared/dictionary.js — the unified status language. IDs DI-xx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICT, label, canMove, nextStates } from '../../shared/dictionary.js';

const machines = ['quote', 'order', 'shipment', 'rma'];

test('DI-01 every transition points to a defined state', () => {
  for (const m of machines) {
    const states = Object.keys(DICT[m].states);
    for (const [from, tos] of Object.entries(DICT[m].transitions)) {
      assert.ok(states.includes(from), `${m}.${from}`);
      for (const to of tos) assert.ok(states.includes(to), `${m}: ${from} → ${to}`);
    }
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
test('DI-04 key business rules encoded in transitions', () => {
  assert.equal(canMove('order', 'awaiting_deposit', 'in_production'), true);
  assert.equal(canMove('order', 'awaiting_deposit', 'shipped'), false, 'cannot ship before production');
  assert.equal(canMove('order', 'shipped', 'cancelled'), false, 'cannot cancel after shipping');
  assert.equal(canMove('quote', 'sent', 'accepted'), true);
  assert.equal(canMove('quote', 'draft', 'accepted'), false, 'customer cannot accept a draft');
  assert.equal(canMove('shipment', 'exception', 'delivered'), true);
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
test('DI-07 label falls back to the raw code; supports English', () => {
  assert.equal(label('order', 'in_production'), '生产/备货中');
  assert.equal(label('order', 'in_production', 'en'), 'In production');
  assert.equal(label('order', 'weird'), 'weird');
  assert.equal(label('nope', 'x'), 'x');
});
test('DI-08 payment terms and incoterms are defined', () => {
  assert.deepEqual(DICT.paymentTerms.map((t) => t.id), ['tt30', 'tt100', 'tt30bl', 'lc']);
  assert.ok(DICT.incoterms.includes('FOB') && DICT.incoterms.includes('DDP'));
});
