import type { Command, EventLevel, RobotMode, RobotState, Vec2 } from '../../app/src/protocol.ts';

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export interface RobotEvent {
  level: EventLevel;
  message: string;
}

const WALK_SPEED_MPS = 0.6;
const LOW_BATTERY = 15;
const MIN_BATTERY_TO_START = 20;
const MAX_QUEUE = 10;
const DEDUPE_WINDOW = 500;

// Battery change in percent per second for each mode.
const BATTERY_RATE: Record<RobotMode, number> = {
  idle: -0.05,
  walking: -0.4,
  working: -0.6,
  paused: -0.05,
  docking: -0.4,
  charging: 5,
  estopped: -0.02,
};

const RESUMABLE: ReadonlySet<RobotMode> = new Set(['walking', 'working', 'docking']);

/**
 * A small simulated humanoid: walks to a task location, works for the task's duration,
 * drains battery, auto-docks when low, and honors pause / resume / dock / e-stop.
 * Pure logic with no I/O so it can be unit tested.
 */
export class SimRobot {
  private s: RobotState = {
    mode: 'idle',
    battery: 100,
    position: { x: 0, y: 0 },
    headingDeg: 0,
    currentTask: null,
    taskProgress: 0,
    queue: [],
  };
  private target: Vec2 | null = null;
  private resumeMode: RobotMode | null = null;
  private lowBatteryWarned = false;
  private readonly results = new Map<string, CommandResult>();
  private readonly pending: RobotEvent[] = [];
  private readonly random: () => number;

  constructor(opts: { random?: () => number; battery?: number } = {}) {
    this.random = opts.random ?? Math.random;
    if (opts.battery !== undefined) this.s.battery = opts.battery;
  }

  snapshot(): RobotState {
    return structuredClone(this.s);
  }

  drainEvents(): RobotEvent[] {
    return this.pending.splice(0);
  }

  /** Applies a command once. Repeating a command id returns the original result (idempotent retries). */
  handle(id: string, command: Command): CommandResult {
    const prior = this.results.get(id);
    if (prior) return prior;
    const result = this.apply(command);
    this.results.set(id, result);
    if (this.results.size > DEDUPE_WINDOW) {
      const oldest = this.results.keys().next().value;
      if (oldest !== undefined) this.results.delete(oldest);
    }
    return result;
  }

  private apply(c: Command): CommandResult {
    const s = this.s;

    if (s.mode === 'estopped' && c.kind !== 'clear_estop' && c.kind !== 'estop') {
      return { ok: false, error: 'Robot is e-stopped' };
    }

    switch (c.kind) {
      case 'estop':
        if (s.mode !== 'estopped') {
          this.resumeMode = null;
          s.mode = 'estopped';
          this.emit('error', 'E-STOP engaged');
        }
        return { ok: true };

      case 'clear_estop':
        if (s.mode !== 'estopped') return { ok: true };
        // Never resume motion on its own after a stop. The operator must press resume.
        if (s.currentTask) {
          s.mode = 'paused';
          this.resumeMode = this.taskPhase();
        } else {
          s.mode = 'idle';
        }
        this.emit('info', 'E-stop cleared');
        return { ok: true };

      case 'enqueue_task': {
        const t = c.task;
        if (!(t.durationSec >= 1 && t.durationSec <= 600)) {
          return { ok: false, error: 'durationSec must be between 1 and 600' };
        }
        if (s.queue.length >= MAX_QUEUE) return { ok: false, error: 'Task queue is full' };
        if (s.currentTask?.id === t.id || s.queue.some((q) => q.id === t.id)) {
          return { ok: false, error: 'Duplicate task id' };
        }
        s.queue.push({ ...t });
        this.emit('info', `Queued "${t.label}"`);
        return { ok: true };
      }

      case 'cancel_task': {
        if (s.currentTask?.id === c.taskId) {
          this.emit('info', `Cancelled "${s.currentTask.label}"`);
          s.currentTask = null;
          s.taskProgress = 0;
          this.target = null;
          if (s.mode !== 'docking' && s.mode !== 'charging') s.mode = 'idle';
          this.resumeMode = null;
          return { ok: true };
        }
        const idx = s.queue.findIndex((q) => q.id === c.taskId);
        if (idx === -1) return { ok: false, error: 'Unknown task' };
        s.queue.splice(idx, 1);
        return { ok: true };
      }

      case 'pause':
        if (!RESUMABLE.has(s.mode)) return { ok: false, error: `Cannot pause while ${s.mode}` };
        this.resumeMode = s.mode;
        s.mode = 'paused';
        return { ok: true };

      case 'resume':
        if (s.mode !== 'paused' || !this.resumeMode) return { ok: false, error: 'Not paused' };
        s.mode = this.resumeMode;
        this.resumeMode = null;
        return { ok: true };

      case 'dock':
        if (s.mode === 'docking' || s.mode === 'charging') return { ok: true };
        this.startDocking('Docking on request');
        return { ok: true };
    }
  }

  step(dtSec: number): void {
    const s = this.s;
    s.battery = clamp(s.battery + BATTERY_RATE[s.mode] * dtSec, 0, 100);

    if (s.battery <= LOW_BATTERY && (s.mode === 'walking' || s.mode === 'working')) {
      if (!this.lowBatteryWarned) this.emit('warn', `Battery ${Math.round(s.battery)}%, returning to dock`);
      this.lowBatteryWarned = true;
      this.startDocking(null);
    }

    switch (s.mode) {
      case 'idle':
        if (s.queue.length > 0 && s.battery >= MIN_BATTERY_TO_START) {
          s.currentTask = s.queue.shift() ?? null;
          s.taskProgress = 0;
          const angle = this.random() * Math.PI * 2;
          const dist = 1 + this.random() * 4;
          this.target = { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
          s.mode = 'walking';
          if (s.currentTask) this.emit('info', `Starting "${s.currentTask.label}"`);
        }
        break;

      case 'walking':
        if (this.target && this.moveToward(this.target, dtSec)) s.mode = 'working';
        break;

      case 'working': {
        const task = s.currentTask;
        if (!task) {
          s.mode = 'idle';
          break;
        }
        s.taskProgress = Math.min(1, s.taskProgress + dtSec / task.durationSec);
        if (s.taskProgress >= 1) {
          this.emit('info', `Finished "${task.label}"`);
          s.currentTask = null;
          s.taskProgress = 0;
          this.target = null;
          s.mode = 'idle';
        }
        break;
      }

      case 'docking':
        if (this.moveToward({ x: 0, y: 0 }, dtSec)) {
          s.mode = 'charging';
          this.emit('info', 'Docked, charging');
        }
        break;

      case 'charging':
        if (s.battery >= 100) {
          s.mode = 'idle';
          this.lowBatteryWarned = false;
          this.emit('info', 'Fully charged');
        }
        break;

      case 'paused':
      case 'estopped':
        break;
    }
  }

  private startDocking(message: string | null): void {
    const s = this.s;
    // An interrupted task goes back to the front of the queue so it isn't lost.
    if (s.currentTask) {
      s.queue.unshift(s.currentTask);
      s.currentTask = null;
      s.taskProgress = 0;
    }
    this.target = null;
    this.resumeMode = null;
    s.mode = 'docking';
    if (message) this.emit('info', message);
  }

  private taskPhase(): RobotMode {
    return this.target && distance(this.s.position, this.target) > 0.01 ? 'walking' : 'working';
  }

  /** Moves toward target; returns true on arrival. */
  private moveToward(target: Vec2, dtSec: number): boolean {
    const p = this.s.position;
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dist = Math.hypot(dx, dy);
    const stepLen = WALK_SPEED_MPS * dtSec;
    if (dist <= stepLen) {
      p.x = target.x;
      p.y = target.y;
      return true;
    }
    p.x += (dx / dist) * stepLen;
    p.y += (dy / dist) * stepLen;
    this.s.headingDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    return false;
  }

  private emit(level: EventLevel, message: string): void {
    this.pending.push({ level, message });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
