import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MissionLogForwarder } from './missionLog.ts';

const ev = (i: number) => ({ level: 'info' as const, message: `e${i}`, ts: i });

function fakeApi(statuses: (number | 'network')[]) {
  const calls: { url: string; headers: Record<string, string>; events: unknown[] }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const s = statuses.shift() ?? 201;
    if (s === 'network') throw new Error('ECONNREFUSED');
    calls.push({ url, headers: init.headers, events: JSON.parse(init.body).events });
    return { ok: s < 300, status: s };
  };
  return { calls, fetchImpl };
}

test('sends events in batches of 100 with the API key', async () => {
  const api = fakeApi([]);
  const f = new MissionLogForwarder({ baseUrl: 'http://log/', robotId: 'sim-1', apiKey: 'k', fetchImpl: api.fetchImpl });
  for (let i = 0; i < 250; i++) f.add(ev(i));
  assert.equal(await f.flush(), 250);
  assert.deepEqual(api.calls.map((c) => c.events.length), [100, 100, 50]);
  assert.equal(api.calls[0].url, 'http://log/api/robots/sim-1/events');
  assert.equal(api.calls[0].headers['x-api-key'], 'k');
  assert.equal(f.pending, 0);
});

test('keeps events when the API is down and delivers them later', async () => {
  const api = fakeApi(['network', 503]);
  const f = new MissionLogForwarder({ baseUrl: 'http://log', robotId: 'r', apiKey: 'k', fetchImpl: api.fetchImpl });
  f.add(ev(1));
  assert.equal(await f.flush(), 0);
  assert.equal(await f.flush(), 0);
  assert.equal(f.pending, 1);
  assert.equal(await f.flush(), 1);
  assert.equal(f.pending, 0);
});

test('drops a batch the API rejects as malformed so it cannot block newer events', async () => {
  const api = fakeApi([400]);
  const f = new MissionLogForwarder({ baseUrl: 'http://log', robotId: 'r', apiKey: 'k', fetchImpl: api.fetchImpl });
  f.add(ev(1));
  await f.flush();
  assert.equal(f.pending, 0);
  assert.equal(f.dropped, 1);
});

test('caps the buffer and counts dropped events', () => {
  const f = new MissionLogForwarder({ baseUrl: 'http://log', robotId: 'r', apiKey: 'k', fetchImpl: fakeApi([]).fetchImpl });
  for (let i = 0; i < 1005; i++) f.add(ev(i));
  assert.equal(f.pending, 1000);
  assert.equal(f.dropped, 5);
});
