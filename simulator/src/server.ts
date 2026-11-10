import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, Command, ServerMessage } from '../../app/src/protocol.ts';
import { SimRobot } from './robot.ts';

const PORT = Number(process.env.PORT ?? 8080);
const TICK_HZ = 10;
// Chaos testing: SIM_DROP_RATE=0.02 drops each client with 2% chance per second.
const DROP_RATE = Number(process.env.SIM_DROP_RATE ?? 0);
// Chaos testing: SIM_ACK_DELAY_MS delays acks to exercise client-side timeouts.
const ACK_DELAY_MS = Number(process.env.SIM_ACK_DELAY_MS ?? 0);

const COMMAND_KINDS = new Set<Command['kind']>([
  'enqueue_task',
  'cancel_task',
  'pause',
  'resume',
  'dock',
  'estop',
  'clear_estop',
]);

/** Validates untrusted client input before it reaches the robot. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type === 'ping' && typeof m.ts === 'number') return { type: 'ping', ts: m.ts };
  if (m.type !== 'command' || typeof m.id !== 'string' || m.id.length > 64) return null;
  const c = m.command as Record<string, unknown> | undefined;
  if (!c || typeof c.kind !== 'string' || !COMMAND_KINDS.has(c.kind as Command['kind'])) return null;
  if (c.kind === 'enqueue_task') {
    const t = c.task as Record<string, unknown> | undefined;
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.label !== 'string' ||
      typeof t.durationSec !== 'number' ||
      !['fetch', 'tidy', 'patrol'].includes(t.kind as string)
    ) {
      return null;
    }
  }
  if (c.kind === 'cancel_task' && typeof c.taskId !== 'string') return null;
  return { type: 'command', id: m.id, command: c as unknown as Command };
}

function main(): void {
  const robot = new SimRobot();
  const wss = new WebSocketServer({ port: PORT });
  let seq = 0;

  const sendTo = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  wss.on('connection', (ws, req) => {
    console.log(`client connected from ${req.socket.remoteAddress}`);
    sendTo(ws, { type: 'telemetry', seq: seq++, ts: Date.now(), state: robot.snapshot() });

    ws.on('message', (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      if (msg.type === 'ping') {
        sendTo(ws, { type: 'pong', ts: msg.ts });
        return;
      }
      const result = robot.handle(msg.id, msg.command);
      const ack: ServerMessage = { type: 'ack', commandId: msg.id, ...result };
      if (ACK_DELAY_MS > 0) setTimeout(() => sendTo(ws, ack), ACK_DELAY_MS);
      else sendTo(ws, ack);
    });

    ws.on('close', () => console.log('client disconnected'));
  });

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    robot.step((now - last) / 1000);
    last = now;
    for (const e of robot.drainEvents()) {
      console.log(`[${e.level}] ${e.message}`);
      broadcast({ type: 'event', level: e.level, message: e.message, ts: now });
    }
    broadcast({ type: 'telemetry', seq: seq++, ts: now, state: robot.snapshot() });
  }, 1000 / TICK_HZ);

  if (DROP_RATE > 0) {
    setInterval(() => {
      for (const ws of wss.clients) {
        if (Math.random() < DROP_RATE) {
          console.log('chaos: dropping client');
          ws.terminate();
        }
      }
    }, 1000);
  }

  console.log(`Robot simulator listening on ws://0.0.0.0:${PORT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
