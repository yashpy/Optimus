import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSummary } from './missionLogApi.ts';

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('maps the API summary into app shape', async () => {
  const s = await fetchSummary(
    'http://log/',
    'sim-1',
    respond(200, { total: 3, by_level: { info: 1, warn: 1, error: 1 }, tasks_finished: 1, estops: 1, last_event_ts: 9 }),
  );
  assert.deepEqual(s, { total: 3, byLevel: { info: 1, warn: 1, error: 1 }, tasksFinished: 1, estops: 1, lastEventTs: 9 });
});

test('rejects HTTP errors and unexpected shapes', async () => {
  await assert.rejects(fetchSummary('http://log', 'r', respond(500, {})), /500/);
  await assert.rejects(fetchSummary('http://log', 'r', respond(200, { total: 'x' })), /Unexpected/);
});
