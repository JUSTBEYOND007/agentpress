export type RecoveryValidationIssue = {
  readonly code: string;
  readonly message: string;
};

export type RecoveryValidation = {
  readonly valid: boolean;
  readonly issues: readonly RecoveryValidationIssue[];
};

export type RecoveryPreservedFacts = {
  readonly kind:
    | 'article_revision'
    | 'artifact_version'
    | 'evidence'
    | 'task_result'
    | 'checkpoint';
  readonly id: string;
  readonly description: string;
  readonly revision: string;
};

export type RecoveryGap = {
  readonly code: string;
  readonly description: string;
  readonly reference?: string;
};

export type RecoveryNextAction = {
  readonly kind: 'repair_settlement' | 'regenerate_artifact' | 'review_manually';
  readonly labelKey: string;
  readonly targetId?: string;
};

export type SettlementRecoveryResult<TCandidate, TSettled> =
  | {
      readonly status: 'recovered';
      readonly candidate: TCandidate;
      readonly settled: TSettled;
      readonly validation: RecoveryValidation;
      readonly settlementAttempts: number;
    }
  | {
      readonly status: 'completed_with_degradation';
      readonly candidate: TCandidate;
      readonly settled?: TSettled;
      readonly validation: RecoveryValidation;
      readonly settlementAttempts: number;
      readonly preservedFacts: readonly RecoveryPreservedFacts[];
      readonly missingFacts: readonly RecoveryGap[];
      readonly unverified: readonly RecoveryGap[];
      readonly nextActions: readonly RecoveryNextAction[];
    }
  | {
      readonly status: 'outcome_unknown';
      readonly candidate: TCandidate;
      readonly settlementAttempts: number;
      readonly preservedFacts: readonly RecoveryPreservedFacts[];
      readonly reason: string;
    };

export class SettlementOutcomeUnknownError extends Error {
  public override readonly name = 'SettlementOutcomeUnknownError';
}

export type SettlementRecoveryInput<TCandidate, TSettled> = {
  readonly candidate: TCandidate;
  readonly initialValidation: RecoveryValidation;
  readonly replaySafe: boolean;
  readonly preservedFacts: readonly RecoveryPreservedFacts[];
  readonly missingFacts: readonly RecoveryGap[];
  readonly nextActions?: readonly RecoveryNextAction[];
  readonly validate: (settled: TSettled) => Promise<RecoveryValidation>;
  readonly settle: (input: {
    readonly candidate: TCandidate;
    readonly allowReapply: true;
    readonly validationFeedback: string;
  }) => Promise<TSettled>;
  readonly maxSettlementRetries?: number;
};

/**
 * Replays only a validated, idempotent settlement operation. Generation is
 * never called here; facts that were already accepted remain frozen on every
 * degraded path.
 */
export async function recoverSettlement<TCandidate, TSettled>(
  input: SettlementRecoveryInput<TCandidate, TSettled>,
): Promise<SettlementRecoveryResult<TCandidate, TSettled>> {
  const maxRetries = input.maxSettlementRetries ?? 1;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 1) {
    throw new RangeError('Settlement recovery retries must be 0 or 1');
  }
  if (input.initialValidation.valid) {
    throw new Error('Settlement recovery requires an initial validation failure');
  }
  if (!input.replaySafe || maxRetries === 0) {
    return degraded(input, input.initialValidation, 0, undefined);
  }

  let settled: TSettled;
  try {
    settled = await input.settle({
      candidate: input.candidate,
      allowReapply: true,
      validationFeedback: validationFeedback(input.initialValidation.issues),
    });
  } catch (error) {
    if (error instanceof SettlementOutcomeUnknownError) {
      return {
        status: 'outcome_unknown',
        candidate: input.candidate,
        settlementAttempts: 1,
        preservedFacts: input.preservedFacts,
        reason: error.message,
      };
    }
    return degraded(
      input,
      {
        valid: false,
        issues: [
          ...input.initialValidation.issues,
          {
            code: 'settlement_retry_failed',
            message: error instanceof Error ? error.message : 'Settlement retry failed',
          },
        ],
      },
      1,
      undefined,
    );
  }

  let validation: RecoveryValidation;
  try {
    validation = await input.validate(settled);
  } catch (error) {
    validation = {
      valid: false,
      issues: [
        ...input.initialValidation.issues,
        {
          code: 'validation_retry_failed',
          message: error instanceof Error ? error.message : 'Validation retry failed',
        },
      ],
    };
  }
  if (validation.valid) {
    return {
      status: 'recovered',
      candidate: input.candidate,
      settled,
      validation,
      settlementAttempts: 1,
    };
  }
  return degraded(input, validation, 1, settled);
}

function degraded<TCandidate, TSettled>(
  input: SettlementRecoveryInput<TCandidate, TSettled>,
  validation: RecoveryValidation,
  settlementAttempts: number,
  settled: TSettled | undefined,
): SettlementRecoveryResult<TCandidate, TSettled> {
  return {
    status: 'completed_with_degradation',
    candidate: input.candidate,
    ...(settled === undefined ? {} : { settled }),
    validation,
    settlementAttempts,
    preservedFacts: input.preservedFacts,
    missingFacts: input.missingFacts,
    unverified: validation.issues.map(({ code, message }) => ({
      code,
      description: message,
    })),
    nextActions: input.nextActions ?? [
      {
        kind: 'repair_settlement',
        labelKey: 'recovery.action.repair_settlement',
      },
    ],
  };
}

function validationFeedback(issues: readonly RecoveryValidationIssue[]): string {
  return [
    'The previous settlement failed validation. Reconcile only the settlement against the candidate.',
    ...issues.map(({ code, message }) => `- [${code}] ${message}`),
  ].join('\n');
}
