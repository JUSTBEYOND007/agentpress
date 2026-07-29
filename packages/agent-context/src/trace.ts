export type TraceEvent = {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
};
export type ReplayState = {
  readonly status: string;
  readonly lastSequence: number;
  readonly taskStates: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
};
export function replayTrace(events: readonly TraceEvent[]): ReplayState {
  let status = 'unknown';
  let lastSequence = 0;
  const taskStates: Record<string, string> = {};
  const warnings: string[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.sequence <= lastSequence)
      throw new Error('Trace sequences must be unique and increasing');
    lastSequence = event.sequence;
    if (event.type.startsWith('run.')) status = event.type.slice(4);
    if (
      event.type === 'task.status' &&
      typeof event.payload.taskId === 'string' &&
      typeof event.payload.status === 'string'
    )
      taskStates[event.payload.taskId] = event.payload.status;
    if (event.type === 'warning' && typeof event.payload.message === 'string')
      warnings.push(event.payload.message);
  }
  return { status, lastSequence, taskStates, warnings };
}
