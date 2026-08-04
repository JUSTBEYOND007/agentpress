export type RunVisualState =
  | 'queued'
  | 'active'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'degraded'
  | 'stale';

export function runVisualState(status: string): RunVisualState {
  if (status.includes('stale') || status.includes('expired')) return 'stale';
  if (status.includes('degradation') || status.includes('degraded')) return 'degraded';
  if (status.includes('cancel') || status.includes('aborted')) return 'cancelled';
  if (status.includes('fail') || status.includes('error') || status.includes('denied')) {
    return 'failed';
  }
  if (
    status.includes('waiting') ||
    status.includes('approval_requested') ||
    status.includes('input_requested')
  ) {
    return 'waiting';
  }
  if (status.includes('succeeded') || status.includes('completed') || status === 'ready') {
    return 'succeeded';
  }
  if (status.includes('queued') || status.includes('proposed')) return 'queued';
  return 'active';
}
