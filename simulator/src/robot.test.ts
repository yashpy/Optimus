import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from '../../app/src/protocol.ts';
import { SimRobot } from './robot.ts';
import { parseClientMessage } from './server.ts';

const task = (id: string, durationSec = 2): Task => ({ id, kind: 'fetch', label: id, durationSec });
const run = (r: SimRobot, seconds: number) => {
  for (let i = 0; i < seconds * 10; i++) r.step(0.1);
};

test('runs a queued task: walk, work, finish', () => {
  const r = new SimRobot({ random: () => 0 }); // target 1 m away
  assert.deepEqual(r.handle('c1', { kind: 'enqueue_task', task: task('t1') }), { ok: true });
  r.step(0.1);
  assert.equal(r.snapshot().mode, 'walking');
  run(r, 2);
  assert.equal(r.snapshot().mode, 'working');
  run(r, 2.1);
  const s = r.snapshot();
  assert.equal(s.mode, 'idle');
  assert.equal(s.currentTask, null);
  assert.ok(r.drainEvents().some((e) => e.message.includes('Finished')));
});

test('repeated command id is applied once', () => {
  const r = new SimRobot();
  r.handle('same', { kind: 'enqueue_task', task: task('t1') });
  const again = r.handle('same', { kind: 'enqueue_task', task: task('t1') });
  assert.deepEqual(again, { ok: true }, 'returns original result, not "duplicate task"');
  assert.equal(r.snapshot().queue.length, 1);
});

test('e-stop blocks commands and does not resume motion when cleared', () => {
  const r = new SimRobot({ random: () => 0 });
  r.handle('1', { kind: 'enqueue_task', task: task('t1', 10) });
  r.step(0.1);
  r.handle('2', { kind: 'estop' });
  const before = r.snapshot().position;
  run(r, 1);
  assert.deepEqual(r.snapshot().position, before, 'no motion while stopped');
  assert.equal(r.handle('3', { kind: 'resume' }).ok, false);
  r.handle('4', { kind: 'clear_estop' });
  assert.equal(r.snapshot().mode, 'paused', 'operator must resume explicitly');
  assert.equal(r.handle('5', { kind: 'resume' }).ok, true);
  assert.equal(r.snapshot().mode, 'walking');
});

test('pause and resume preserve the task phase', () => {
  const r = new SimRobot({ random: () => 0 });
  r.handle('1', { kind: 'enqueue_task', task: task('t1', 10) });
  run(r, 3);
  assert.equal(r.snapshot().mode, 'working');
  r.handle('2', { kind: 'pause' });
  const progress = r.snapshot().taskProgress;
  run(r, 2);
  assert.equal(r.snapshot().taskProgress, progress);
  r.handle('3', { kind: 'resume' });
  assert.equal(r.snapshot().mode, 'working');
});

test('will not start a task below 20% battery', () => {
  const r = new SimRobot({ battery: 19 });
  r.handle('1', { kind: 'enqueue_task', task: task('t1') });
  run(r, 1);
  assert.equal(r.snapshot().mode, 'idle');
  assert.equal(r.snapshot().queue.length, 1);
});

test('low battery auto-docks and keeps the interrupted task', () => {
  const r = new SimRobot({ random: () => 0, battery: 21 });
  r.handle('1', { kind: 'enqueue_task', task: task('t1', 60) });
  run(r, 15);
  const s = r.snapshot();
  assert.ok(s.mode === 'docking' || s.mode === 'charging', `mode was ${s.mode}`);
  assert.equal(s.queue[0]?.id, 't1');
  assert.ok(r.drainEvents().some((e) => e.level === 'warn'));
});

test('validates task input', () => {
  const r = new SimRobot();
  assert.equal(r.handle('1', { kind: 'enqueue_task', task: task('t', 0) }).ok, false);
  for (let i = 0; i < 10; i++) r.handle(`q${i}`, { kind: 'enqueue_task', task: task(`t${i}`) });
  assert.equal(r.handle('full', { kind: 'enqueue_task', task: task('x') }).error, 'Task queue is full');
  assert.equal(r.handle('c', { kind: 'cancel_task', taskId: 'nope' }).ok, false);
});

test('server rejects malformed client messages', () => {
  assert.equal(parseClientMessage('{'), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'command', id: 'a', command: { kind: 'selfdestruct' } })), null);
  assert.equal(
    parseClientMessage(JSON.stringify({ type: 'command', id: 'a', command: { kind: 'enqueue_task', task: { id: 1 } } })),
    null,
  );
  assert.equal(parseClientMessage(JSON.stringify({ type: 'command', id: 'x'.repeat(65), command: { kind: 'pause' } })), null);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'ping', ts: 1 })), { type: 'ping', ts: 1 });
});
