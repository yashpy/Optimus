import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffDelay } from './backoff.ts';
import { parseServerMessage } from './protocol.ts';

test('backoff grows exponentially and is capped', () => {
  const max = () => 0.999999;
  const opts = { baseMs: 500, maxMs: 15_000 };
  assert.equal(backoffDelay(0, opts, max), 499);
  assert.equal(backoffDelay(3, opts, max), 3999);
  assert.equal(backoffDelay(20, opts, max), 14_999);
  assert.equal(backoffDelay(5, opts, () => 0), 0);
});

test('parseServerMessage rejects malformed frames', () => {
  assert.equal(parseServerMessage('not json'), null);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'nope' })), null);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'telemetry', seq: 'x', state: {} })), null);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'ack', commandId: 1, ok: true })), null);
  assert.equal(parseServerMessage(new ArrayBuffer(4)), null);
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: 'pong', ts: 5 })), { type: 'pong', ts: 5 });
});
