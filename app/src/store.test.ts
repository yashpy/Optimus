import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RobotState } from './protocol.ts';
import { initialState, isStale, MAX_COMMANDS, reducer, STALE_AFTER_MS, type AppState } from './store.ts';

const robot = (battery: number): RobotState => ({
  mode: 'idle',
  battery,
  position: { x: 0, y: 0 },
  headingDeg: 0,
  currentTask: null,
  taskProgress: 0,
  queue: [],
});

const connected = (): AppState => reducer(initialState, { type: 'connection_changed', status: 'connected' });

test('drops out-of-order and duplicate telemetry frames', () => {
  let s = connected();
  s = reducer(s, { type: 'telemetry', seq: 5, state: robot(90), receivedAt: 1 });
  s = reducer(s, { type: 'telemetry', seq: 4, state: robot(95), receivedAt: 2 });
  s = reducer(s, { type: 'telemetry', seq: 5, state: robot(95), receivedAt: 3 });
  assert.equal(s.robot?.battery, 90);
  assert.equal(s.droppedFrames, 2);
  assert.equal(s.lastTelemetryAt, 1);
});

test('accepts a restarted robot whose seq starts over after reconnect', () => {
  let s = connected();
  s = reducer(s, { type: 'telemetry', seq: 100, state: robot(50), receivedAt: 1 });
  s = reducer(s, { type: 'connection_changed', status: 'reconnecting' });
  s = reducer(s, { type: 'connection_changed', status: 'connected' });
  s = reducer(s, { type: 'telemetry', seq: 0, state: robot(100), receivedAt: 2 });
  assert.equal(s.robot?.battery, 100);
});

test('state is stale when telemetry stops or the link is down', () => {
  let s = connected();
  assert.equal(isStale(s, 0), true, 'no telemetry yet');
  s = reducer(s, { type: 'telemetry', seq: 0, state: robot(80), receivedAt: 1000 });
  assert.equal(isStale(s, 1000 + STALE_AFTER_MS), false);
  assert.equal(isStale(s, 1001 + STALE_AFTER_MS), true);
  s = reducer(s, { type: 'connection_changed', status: 'reconnecting' });
  assert.equal(isStale(s, 1000), true);
});

test('late ack after a timeout still updates the command', () => {
  let s = reducer(initialState, { type: 'command_created', id: 'a', command: { kind: 'pause' }, status: 'sent', at: 0 });
  s = reducer(s, { type: 'command_status', id: 'a', status: 'timed_out' });
  s = reducer(s, { type: 'command_status', id: 'a', status: 'acked' });
  assert.equal(s.commands.a.status, 'acked');
  // But a final answer from the robot is not overwritten.
  s = reducer(s, { type: 'command_status', id: 'a', status: 'queued' });
  assert.equal(s.commands.a.status, 'acked');
});

test('command history is capped but never evicts pending commands', () => {
  let s = initialState;
  s = reducer(s, { type: 'command_created', id: 'pending', command: { kind: 'dock' }, status: 'sent', at: 0 });
  for (let i = 0; i < MAX_COMMANDS + 5; i++) {
    s = reducer(s, { type: 'command_created', id: `c${i}`, command: { kind: 'pause' }, status: 'acked', at: i });
  }
  assert.equal(s.commandOrder.length, MAX_COMMANDS);
  assert.ok(s.commands.pending, 'pending command kept');
  assert.equal(Object.keys(s.commands).length, MAX_COMMANDS);
});
