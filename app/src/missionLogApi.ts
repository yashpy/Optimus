export interface MissionSummary {
  total: number;
  byLevel: { info: number; warn: number; error: number };
  tasksFinished: number;
  estops: number;
  lastEventTs: number | null;
}

/** Fetches the robot's summary from the Mission Log API and validates the response shape. */
export async function fetchSummary(
  baseUrl: string,
  robotId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MissionSummary> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/robots/${encodeURIComponent(robotId)}/summary`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Mission log returned ${res.status}`);
  const d = (await res.json()) as Record<string, unknown>;
  const lv = d.by_level as Record<string, unknown> | undefined;
  const num = (v: unknown) => (typeof v === 'number' ? v : NaN);
  const summary: MissionSummary = {
    total: num(d.total),
    byLevel: { info: num(lv?.info), warn: num(lv?.warn), error: num(lv?.error) },
    tasksFinished: num(d.tasks_finished),
    estops: num(d.estops),
    lastEventTs: d.last_event_ts === null ? null : num(d.last_event_ts),
  };
  const values = [summary.total, summary.tasksFinished, summary.estops, ...Object.values(summary.byLevel)];
  if (values.some(Number.isNaN)) throw new Error('Unexpected response from mission log');
  return summary;
}
