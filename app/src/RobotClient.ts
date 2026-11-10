import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.ts';
import {
  isSafetyCritical,
  parseServerMessage,
  type ClientMessage,
  type Command,
} from './protocol.ts';
import type { Action } from './store.ts';

/** The subset of the WebSocket API the client needs. React Native's WebSocket satisfies it. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface RobotClientOptions {
  url: string;
  dispatch: (action: Action) => void;
  createSocket?: (url: string) => SocketLike;
  ackTimeoutMs?: number;
  heartbeatMs?: number;
  backoff?: BackoffOptions;
  random?: () => number;
}

interface InFlight {
  command: Command;
  timer: ReturnType<typeof setTimeout>;
}

let idCounter = 0;
export function newCommandId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Owns the WebSocket link to one robot.
 *
 * - Reconnects with jittered exponential backoff until disconnect() is called.
 * - Sends a ping every heartbeatMs; a link with no traffic for 3 heartbeats is treated as dead.
 * - Every command gets an id and an ack timeout. The robot dedupes by id, so resending is safe.
 * - Non-safety commands issued while offline are queued and flushed on reconnect.
 * - E-stop is never queued: a stop that arrives seconds late is worse than a clear failure.
 */
export class RobotClient {
  private readonly url: string;
  private readonly dispatch: (action: Action) => void;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly ackTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;

  private socket: SocketLike | null = null;
  private open = false;
  private shouldRun = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;

  private readonly outbox: { id: string; command: Command }[] = [];
  private readonly inFlight = new Map<string, InFlight>();

  constructor(opts: RobotClientOptions) {
    this.url = opts.url;
    this.dispatch = opts.dispatch;
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 3000;
    this.heartbeatMs = opts.heartbeatMs ?? 1000;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.random = opts.random ?? Math.random;
  }

  connect(): void {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.attempt = 0;
    this.dispatch({ type: 'connection_changed', status: 'connecting' });
    this.openSocket();
  }

  disconnect(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardownSocket();
    for (const [id, f] of this.inFlight) {
      clearTimeout(f.timer);
      this.dispatch({ type: 'command_status', id, status: 'timed_out', error: 'Disconnected before ack' });
    }
    this.inFlight.clear();
    for (const q of this.outbox.splice(0)) {
      this.dispatch({ type: 'command_status', id: q.id, status: 'rejected', error: 'Disconnected' });
    }
    this.dispatch({ type: 'connection_changed', status: 'disconnected' });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Issues a command and returns its id. Status updates arrive through dispatch. */
  send(command: Command): string {
    const id = newCommandId();
    const at = Date.now();

    if (this.open) {
      this.dispatch({ type: 'command_created', id, command, status: 'sent', at });
      this.transmit(id, command);
      return id;
    }

    if (isSafetyCritical(command.kind)) {
      this.dispatch({
        type: 'command_created',
        id,
        command,
        status: 'rejected',
        at,
        error: 'Not connected. E-stop was NOT delivered; use the robot’s physical stop.',
      });
      return id;
    }

    this.outbox.push({ id, command });
    this.dispatch({ type: 'command_created', id, command, status: 'queued', at });
    return id;
  }

  private transmit(id: string, command: Command): void {
    const msg: ClientMessage = { type: 'command', id, command };
    this.socket?.send(JSON.stringify(msg));
    const timer = setTimeout(() => {
      this.inFlight.delete(id);
      this.dispatch({ type: 'command_status', id, status: 'timed_out', error: 'No ack from robot' });
    }, this.ackTimeoutMs);
    this.inFlight.set(id, { command, timer });
  }

  private openSocket(): void {
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch (err) {
      this.log('error', `Could not open socket: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.dispatch({ type: 'connection_changed', status: 'connected' });
      this.startHeartbeat();
      // Flush commands queued while offline, oldest first.
      for (const q of this.outbox.splice(0)) {
        this.dispatch({ type: 'command_status', id: q.id, status: 'sent' });
        this.transmit(q.id, q.command);
      }
    };

    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      const msg = parseServerMessage(ev.data);
      if (!msg) return;
      switch (msg.type) {
        case 'telemetry':
          this.dispatch({ type: 'telemetry', seq: msg.seq, state: msg.state, receivedAt: Date.now() });
          break;
        case 'ack': {
          const f = this.inFlight.get(msg.commandId);
          if (f) clearTimeout(f.timer);
          this.inFlight.delete(msg.commandId);
          this.dispatch({
            type: 'command_status',
            id: msg.commandId,
            status: msg.ok ? 'acked' : 'rejected',
            error: msg.error,
          });
          break;
        }
        case 'event':
          this.log(msg.level, msg.message, msg.ts);
          break;
        case 'pong':
          this.dispatch({ type: 'rtt', ms: Math.max(0, Date.now() - msg.ts) });
          break;
      }
    };

    socket.onerror = () => {
      // onclose always follows; reconnect logic lives there.
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.handleLinkLost();
    };
  }

  private handleLinkLost(): void {
    this.teardownSocket();
    // Commands that were sent but not acked may or may not have reached the robot.
    // Ordinary commands go back in the outbox (robot dedupes by id). Safety commands fail loudly.
    for (const [id, f] of this.inFlight) {
      clearTimeout(f.timer);
      if (isSafetyCritical(f.command.kind)) {
        this.dispatch({
          type: 'command_status',
          id,
          status: 'timed_out',
          error: 'Link lost before the robot confirmed. Check the robot.',
        });
      } else {
        this.outbox.push({ id, command: f.command });
        this.dispatch({ type: 'command_status', id, status: 'queued' });
      }
    }
    this.inFlight.clear();
    if (this.shouldRun) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt, this.backoff, this.random);
    this.attempt += 1;
    this.dispatch({ type: 'connection_changed', status: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) this.openSocket();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.open) return;
      if (Date.now() - this.lastMessageAt > this.heartbeatMs * 3) {
        this.log('warn', 'Robot link silent, reconnecting');
        this.handleLinkLost();
        return;
      }
      const ping: ClientMessage = { type: 'ping', ts: Date.now() };
      this.socket?.send(JSON.stringify(ping));
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private teardownSocket(): void {
    this.stopHeartbeat();
    this.open = false;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onclose = s.onerror = s.onmessage = null;
      try {
        s.close();
      } catch {
        // already closed
      }
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string, ts = Date.now()): void {
    this.dispatch({ type: 'log', level, message, ts });
  }
}
