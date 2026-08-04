export type ToolReplaySafety = 'replay_safe' | 'idempotent' | 'side_effecting' | 'outcome_unknown';
export type ToolCallRecoveryStatus =
  | 'proposed'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled';
export type ToolReplayAction = 'execute' | 'resume' | 'skip' | 'fail_closed';

export function decideToolReplay(input: {
  readonly status: ToolCallRecoveryStatus;
  readonly safety: ToolReplaySafety;
  readonly idempotencyKey?: string;
}): ToolReplayAction {
  if (input.status === 'succeeded' || input.status === 'failed' || input.status === 'cancelled') {
    return 'skip';
  }
  if (input.status === 'proposed' || input.status === 'awaiting_approval') return 'execute';
  if (input.status === 'approved') return 'execute';
  if (input.status === 'executing') {
    if (input.safety === 'replay_safe') return 'resume';
    if (input.safety === 'idempotent' && input.idempotencyKey) return 'resume';
    return 'fail_closed';
  }
  if (input.safety === 'replay_safe') return 'resume';
  if (input.safety === 'idempotent' && input.idempotencyKey) return 'resume';
  return 'fail_closed';
}
