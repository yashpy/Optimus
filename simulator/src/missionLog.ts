import type { EventLevel } from '../../app/src/protocol.ts';

export interface LoggedEvent {
  level: EventLevel;
  message: string;
  ts: number;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

const BATCH = 100; // matches the API's per-request limit
const MAX_BUFFER = 1000;

/**
 * Batches robot events and POSTs them to the Mission Log API.
 * If the API is down, events stay buffered (oldest dropped past MAX_BUFFER) and are retried next flush.
 */
export class MissionLogForwarder {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private buffer: LoggedEvent[] = [];
  private inFlight = false;
  dropped = 0;

  constructor(opts: { baseUrl: string; robotId: string; apiKey: string; fetchImpl?: FetchLike }) {
    this.endpoint = `${opts.baseUrl.replace(/\/$/, '')}/api/robots/${encodeURIComponent(opts.robotId)}/events`;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  get pending(): number {
    return this.buffer.length;
  }

  add(e: LoggedEvent): void {
    this.buffer.push(e);
    if (this.buffer.length > MAX_BUFFER) {
      this.dropped += this.buffer.length - MAX_BUFFER;
      this.buffer = this.buffer.slice(-MAX_BUFFER);
    }
  }

  /** Sends buffered events in batches. Returns the number delivered. */
  async flush(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    let sent = 0;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.slice(0, BATCH);
        let res;
        try {
          res = await this.fetchImpl(this.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
            body: JSON.stringify({ events: batch }),
          });
        } catch {
          break; // network error: keep events for the next flush
        }
        if (!res.ok) {
          if (res.status === 400 || res.status === 413) {
            // The API will never accept this batch; drop it so it can't block newer events.
            this.dropped += batch.length;
            this.buffer.splice(0, batch.length);
            continue;
          }
          break; // 401/5xx: retry later
        }
        this.buffer.splice(0, batch.length);
        sent += batch.length;
      }
    } finally {
      this.inFlight = false;
    }
    return sent;
  }
}
