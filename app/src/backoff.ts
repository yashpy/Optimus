export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 15_000 };

/**
 * Exponential backoff with "full jitter": a random delay in [0, min(max, base * 2^attempt)].
 * Jitter keeps many phones from reconnecting to the robot in lockstep.
 */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}
