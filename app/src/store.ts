import type { Command, EventLevel, RobotState } from './protocol.ts';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type CommandStatus = 'queued' | 'sent' | 'acked' | 'rejected' | 'timed_out';

export interface CommandRecord {
  id: string;
  command: Command;
  status: CommandStatus;
  error?: string;
  createdAt: number;
}

export interface LogEntry {
  id: number;
  level: EventLevel;
  message: string;
  ts: number;
}

export interface AppState {
  connection: ConnectionStatus;
  robot: RobotState | null;
  lastSeq: number;
  lastTelemetryAt: number | null;
  droppedFrames: number;
  rttMs: number | null;
  commands: Record<string, CommandRecord>;
  commandOrder: string[];
  log: LogEntry[];
  nextLogId: number;
}

export type Action =
  | { type: 'connection_changed'; status: ConnectionStatus }
  | { type: 'telemetry'; seq: number; state: RobotState; receivedAt: number }
  | { type: 'command_created'; id: string; command: Command; status: CommandStatus; at: number; error?: string }
  | { type: 'command_status'; id: string; status: CommandStatus; error?: string }
  | { type: 'log'; level: EventLevel; message: string; ts: number }
  | { type: 'rtt'; ms: number };

export const MAX_COMMANDS = 25;
export const MAX_LOG = 50;
export const STALE_AFTER_MS = 2000;

export const initialState: AppState = {
  connection: 'disconnected',
  robot: null,
  lastSeq: -1,
  lastTelemetryAt: null,
  droppedFrames: 0,
  rttMs: null,
  commands: {},
  commandOrder: [],
  log: [],
  nextLogId: 1,
};

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'connection_changed': {
      if (action.status === state.connection) return state;
      // A new session may come from a restarted robot whose seq starts over.
      const lastSeq = action.status === 'connected' ? -1 : state.lastSeq;
      return { ...state, connection: action.status, lastSeq };
    }

    case 'telemetry': {
      // Drop late or duplicate frames so the UI never moves backwards in time.
      if (action.seq <= state.lastSeq) {
        return { ...state, droppedFrames: state.droppedFrames + 1 };
      }
      return {
        ...state,
        robot: action.state,
        lastSeq: action.seq,
        lastTelemetryAt: action.receivedAt,
      };
    }

    case 'command_created': {
      const record: CommandRecord = {
        id: action.id,
        command: action.command,
        status: action.status,
        error: action.error,
        createdAt: action.at,
      };
      const order = [...state.commandOrder, action.id];
      const commands = { ...state.commands, [action.id]: record };
      // Keep only the most recent commands, but never evict one still waiting on the robot.
      while (order.length > MAX_COMMANDS) {
        const idx = order.findIndex((id) => isFinal(commands[id].status));
        if (idx === -1) break;
        delete commands[order[idx]];
        order.splice(idx, 1);
      }
      return { ...state, commands, commandOrder: order };
    }

    case 'command_status': {
      const existing = state.commands[action.id];
      if (!existing) return state;
      // A late ack after a timeout is still useful: the robot did respond.
      if (isFinal(existing.status) && existing.status !== 'timed_out') return state;
      return {
        ...state,
        commands: {
          ...state.commands,
          [action.id]: { ...existing, status: action.status, error: action.error },
        },
      };
    }

    case 'log': {
      const entry: LogEntry = {
        id: state.nextLogId,
        level: action.level,
        message: action.message,
        ts: action.ts,
      };
      return {
        ...state,
        log: [entry, ...state.log].slice(0, MAX_LOG),
        nextLogId: state.nextLogId + 1,
      };
    }

    case 'rtt':
      return { ...state, rttMs: action.ms };
  }
}

export function isFinal(status: CommandStatus): boolean {
  return status === 'acked' || status === 'rejected' || status === 'timed_out';
}

export function isStale(state: AppState, now: number): boolean {
  if (state.connection !== 'connected' || state.lastTelemetryAt === null) return true;
  return now - state.lastTelemetryAt > STALE_AFTER_MS;
}
