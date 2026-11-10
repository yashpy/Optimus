// Wire protocol shared by the mobile app and the robot simulator.
// All messages are JSON over a single WebSocket connection.

export type RobotMode =
  | 'idle'
  | 'walking'
  | 'working'
  | 'paused'
  | 'docking'
  | 'charging'
  | 'estopped';

export type TaskKind = 'fetch' | 'tidy' | 'patrol';

export interface Task {
  id: string;
  kind: TaskKind;
  label: string;
  durationSec: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface RobotState {
  mode: RobotMode;
  battery: number; // 0..100
  position: Vec2; // meters, dock is at (0, 0)
  headingDeg: number;
  currentTask: Task | null;
  taskProgress: number; // 0..1 for the working phase of currentTask
  queue: Task[];
}

export type Command =
  | { kind: 'enqueue_task'; task: Task }
  | { kind: 'cancel_task'; taskId: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'dock' }
  | { kind: 'estop' }
  | { kind: 'clear_estop' };

export type CommandKind = Command['kind'];

// App -> robot
export type ClientMessage =
  | { type: 'command'; id: string; command: Command }
  | { type: 'ping'; ts: number };

export type EventLevel = 'info' | 'warn' | 'error';

// Robot -> app
export type ServerMessage =
  | { type: 'telemetry'; seq: number; ts: number; state: RobotState }
  | { type: 'ack'; commandId: string; ok: boolean; error?: string }
  | { type: 'event'; level: EventLevel; message: string; ts: number }
  | { type: 'pong'; ts: number };

const SERVER_TYPES = new Set(['telemetry', 'ack', 'event', 'pong']);

/**
 * Parses an incoming robot message. Returns null for anything malformed so a
 * bad frame from the robot can never crash the app.
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const msg = data as { type?: unknown };
  if (typeof msg.type !== 'string' || !SERVER_TYPES.has(msg.type)) return null;

  if (msg.type === 'telemetry') {
    const t = data as { seq?: unknown; state?: unknown };
    if (typeof t.seq !== 'number' || typeof t.state !== 'object' || t.state === null) {
      return null;
    }
  }
  if (msg.type === 'ack') {
    const a = data as { commandId?: unknown; ok?: unknown };
    if (typeof a.commandId !== 'string' || typeof a.ok !== 'boolean') return null;
  }
  return data as ServerMessage;
}

/** Commands that must never be queued for later delivery. */
export function isSafetyCritical(kind: CommandKind): boolean {
  return kind === 'estop' || kind === 'clear_estop';
}
