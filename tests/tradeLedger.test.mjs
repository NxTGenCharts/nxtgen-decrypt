import test from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicateBotTrade, dedupeBotTrades, feeOf } from '../js/futures/tradeLedger.js';

const row = (o) => ({ gridId: 'b1', netUsd: -1.5, closedAtMs: 1_000_000, ...o });

test('same close order id is one trade', () => {
  assert.equal(isDuplicateBotTrade([row({ closeOrderId: 'A1', gridLevel: 2 })], row({ closeOrderId: 'A1', gridLevel: 2 })), true);
});
test('different order ids are different trades even with equal net', () => {
  assert.equal(isDuplicateBotTrade([row({ closeOrderId: 'A1', gridLevel: 2 })], row({ closeOrderId: 'A2', gridLevel: 2 })), false);
});
test('no order id: same bot/level/net within 2 min is a duplicate, outside is not', () => {
  assert.equal(isDuplicateBotTrade([row({})], row({ closedAtMs: 1_000_500 })), true);
  assert.equal(isDuplicateBotTrade([row({})], row({ closedAtMs: 1_000_000 + 200_000 })), false);
});
test('other bots and non-bot rows are never duplicates', () => {
  assert.equal(isDuplicateBotTrade([row({})], row({ gridId: 'b2' })), false);
  assert.equal(isDuplicateBotTrade([{ netUsd: -1.5, closedAtMs: 1_000_000 }], { netUsd: -1.5, closedAtMs: 1_000_000 }), false);
});
test('dedupeBotTrades keeps the oldest copy and reports the rest', () => {
  const a = row({ id: 'x', closedAtMs: 1_000_000 }), b = row({ id: 'y', closedAtMs: 1_000_900 });
  const other = row({ id: 'z', gridId: 'b2' });
  const { kept, removed } = dedupeBotTrades([b, a, other]);
  assert.deepEqual(removed, [b]);
  assert.deepEqual(kept, [a, other]);
});
test('feeOf is always a cost, null when absent', () => {
  assert.equal(feeOf({ feesUsd: -0.2 }), 0.2);
  assert.equal(feeOf({ feesUsd: null }), null);
});
