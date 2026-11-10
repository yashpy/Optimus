import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { ClientMessage, ServerMessage } from './protocol.ts';
import { RobotClient, type SocketLike } from './RobotClient.ts';
import { initialState, reducer, type Action, type AppState } from './store.ts';

class FakeSocket implements SocketLike {
  sent: ClientMessage[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  serverOpen() {
    this.onopen?.();
  }
  serverSend(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverDrop() {
    this.onclose?.();
  }
  commands() {
    return this.sent.filter((m) => m.type === 'command');
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  let state: AppState = initialState;
  const dispatch = (a: Action) => {
    state = reducer(state, a);
  };
  const client = new RobotClient({
    url: 'ws://robot',
    dispatch,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    ackTimeoutMs: 3000,
    heartbeatMs: 1000,
    random: () => 0.5,
  });
  return { client, sockets, get state() { return state; } };
}

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] }));
afterEach(() => mock.timers.reset());

test('acked command reaches final state', () => {
  const t = setup();
  t.client.connect();
  t.sockets[0].serverOpen();
  const id = t.client.send({ kind: 'pause' });
  assert.equal(t.state.commands[id].status, 'sent');
  t.sockets[0].serverSend({ type: 'ack', commandId: id, ok: true });
  assert.equal(t.state.commands[id].status, 'acked');
  mock.timers.tick(5000);
  assert.equal(t.state.commands[id].status, 'acked', 'timeout was cleared');
});

test('command without ack times out', () => {
  const t = setup();
  t.client.connect();
  t.sockets[0].serverOpen();
  const id = t.client.send({ kind: 'dock' });
  // Keep the link alive with telemetry so the heartbeat watchdog doesn't fire.
  for (let i = 0; i < 3; i++) {
    mock.timers.tick(1000);
    t.sockets[0].serverSend({ type: 'pong', ts: Date.now() });
  }
  assert.equal(t.state.commands[id].status, 'timed_out');
});

test('commands issued offline are queued and flushed on connect', () => {
  const t = setup();
  t.client.connect();
  const id = t.client.send({ kind: 'dock' });
  assert.equal(t.state.commands[id].status, 'queued');
  assert.equal(t.sockets[0].commands().length, 0);
  t.sockets[0].serverOpen();
  assert.equal(t.state.commands[id].status, 'sent');
  assert.equal(t.sockets[0].commands()[0].type === 'command' && t.sockets[0].commands()[0].id, id);
});

test('e-stop is never queued while offline', () => {
  const t = setup();
  t.client.connect();
  const id = t.client.send({ kind: 'estop' });
  assert.equal(t.state.commands[id].status, 'rejected');
  assert.match(t.state.commands[id].error ?? '', /NOT delivered/);
  t.sockets[0].serverOpen();
  assert.equal(t.sockets[0].commands().length, 0, 'stale e-stop not sent later');
});

test('link loss re-sends unacked commands with the same id and fails unacked e-stop', () => {
  const t = setup();
  t.client.connect();
  t.sockets[0].serverOpen();
  const dockId = t.client.send({ kind: 'dock' });
  const stopId = t.client.send({ kind: 'estop' });
  t.sockets[0].serverDrop();

  assert.equal(t.state.connection, 'reconnecting');
  assert.equal(t.state.commands[dockId].status, 'queued');
  assert.equal(t.state.commands[stopId].status, 'timed_out');

  mock.timers.tick(250); // backoff(0) with random=0.5 -> 250ms
  assert.equal(t.sockets.length, 2);
  t.sockets[1].serverOpen();
  const resent = t.sockets[1].commands();
  assert.equal(resent.length, 1);
  assert.equal(resent[0].type === 'command' && resent[0].id, dockId, 'same id so robot can dedupe');
});

test('reconnect delays back off exponentially', () => {
  const t = setup();
  t.client.connect();
  t.sockets[0].serverDrop(); // attempt 0 -> 250ms
  mock.timers.tick(250);
  t.sockets[1].serverDrop(); // attempt 1 -> 500ms
  mock.timers.tick(499);
  assert.equal(t.sockets.length, 2);
  mock.timers.tick(1);
  assert.equal(t.sockets.length, 3);
});

test('silent link is detected by heartbeat and reconnected', () => {
  const t = setup();
  t.client.connect();
  t.sockets[0].serverOpen();
  mock.timers.tick(1000);
  assert.ok(t.sockets[0].sent.some((m) => m.type === 'ping'));
  mock.timers.tick(3000); // no traffic from robot for > 3 heartbeats
  assert.equal(t.sockets[0].closed, true);
  assert.equal(t.state.connection, 'reconnecting');
});

test('disconnect stops reconnecting', () => {
  const t = setup();
  t.client.connect();
  t.sockets[0].serverOpen();
  t.client.disconnect();
  mock.timers.tick(60_000);
  assert.equal(t.sockets.length, 1);
  assert.equal(t.state.connection, 'disconnected');
});
