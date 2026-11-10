// End-to-end: the app's real RobotClient talking to the real simulator process over WebSocket.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { RobotClient, type SocketLike } from '../../app/src/RobotClient.ts';
import { initialState, reducer, type Action, type AppState } from '../../app/src/store.ts';

const PORT = 18_000 + Math.floor(Math.random() * 1000);
let sim: ChildProcess;

before(async () => {
  const server = fileURLToPath(new URL('./server.ts', import.meta.url));
  sim = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    sim.stdout!.on('data', (d: Buffer) => d.toString().includes('listening') && resolve());
    sim.on('exit', (code) => reject(new Error(`simulator exited ${code}`)));
  });
});

after(() => {
  sim.kill();
});

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(20);
  }
}

test('app client connects, receives telemetry, and gets acks for commands', async () => {
  let state: AppState = initialState;
  const client = new RobotClient({
    url: `ws://127.0.0.1:${PORT}`,
    dispatch: (a: Action) => {
      state = reducer(state, a);
    },
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  });
  client.connect();
  await until(() => state.connection === 'connected' && state.robot !== null);

  const taskId = 'e2e-task';
  const enqueue = client.send({
    kind: 'enqueue_task',
    task: { id: taskId, kind: 'patrol', label: 'E2E patrol', durationSec: 30 },
  });
  await until(() => state.commands[enqueue].status === 'acked');
  await until(() => state.robot?.currentTask?.id === taskId);

  const stop = client.send({ kind: 'estop' });
  await until(() => state.commands[stop].status === 'acked' && state.robot?.mode === 'estopped');

  const blocked = client.send({ kind: 'resume' });
  await until(() => state.commands[blocked].status === 'rejected');
  assert.equal(state.commands[blocked].error, 'Robot is e-stopped');

  const clear = client.send({ kind: 'clear_estop' });
  await until(() => state.commands[clear].status === 'acked' && state.robot?.mode === 'paused');

  await until(() => state.rttMs !== null);
  assert.ok(state.log.some((e) => e.message.includes('E-STOP')));
  client.disconnect();
});
