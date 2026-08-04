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

/**
 * Resolves the conservative recovery class for a registered tool. An explicit
 * declaration wins; otherwise read-only tools are replay-safe, keyed tools are
 * idempotent, and every remaining tool is treated as side-effecting.
 */
export function resolveToolReplaySafety(input: {
  readonly risk: 'read_only' | 'draft_write' | 'external_write' | 'destructive';
  readonly idempotency: 'none' | 'provider_key';
  readonly replaySafety?: ToolReplaySafety;
}): ToolReplaySafety {
  if (input.replaySafety) return input.replaySafety;
  if (input.risk === 'read_only') return 'replay_safe';
  if (input.idempotency === 'provider_key') return 'idempotent';
  return 'side_effecting';
}

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
