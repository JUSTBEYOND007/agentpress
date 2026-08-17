import type { TSchema } from '@sinclair/typebox';

import {
  assertSpecialistArtifactPolicy,
  assertStrictSchema,
  normalizeSpecialistArtifacts,
  researcherSubmissionEvidenceIds,
  type StructuredArtifact,
} from './planned-run-protocol.js';
import type { SpecialistRole } from './specialist-task-contract.js';

export type SpecialistSubmissionFailureCode =
  | 'task_result_schema_invalid'
  | 'task_artifact_invalid'
  | 'task_evidence_invalid'
  | 'task_evidence_provenance_invalid';

export class SpecialistSubmissionError extends Error {
  public override readonly name = 'SpecialistSubmissionError';

  public constructor(
    public readonly code: SpecialistSubmissionFailureCode,
    public override readonly cause: unknown,
  ) {
    super(code, { cause });
  }
}

export type ValidatedSpecialistSubmission = {
  readonly status: 'succeeded' | 'failed';
  readonly summary: string;
  readonly artifacts: readonly StructuredArtifact[];
  readonly warnings: readonly string[];
  readonly failure?: string;
};

export async function validateSpecialistSubmission(input: {
  readonly schema: TSchema;
  readonly value: unknown;
  readonly role: SpecialistRole;
  readonly resolveEvidenceProviderRevision: (
    evidenceIds: readonly string[],
  ) => Promise<string | undefined>;
  readonly assertEvidence: (evidenceIds: readonly string[]) => Promise<void>;
  readonly assertEditProposals: (proposalIds: readonly string[]) => Promise<void>;
}): Promise<ValidatedSpecialistSubmission> {
  try {
    assertStrictSchema(input.schema, input.value, 'task_complete');
  } catch (error) {
    throw new SpecialistSubmissionError('task_result_schema_invalid', error);
  }
  const submitted = input.value as ValidatedSpecialistSubmission;
  let providerRevision: string | undefined;
  try {
    providerRevision =
      input.role === 'researcher' && submitted.artifacts.length > 0
        ? await input.resolveEvidenceProviderRevision(
            researcherSubmissionEvidenceIds(submitted.artifacts),
          )
        : undefined;
  } catch (error) {
    throw new SpecialistSubmissionError('task_evidence_provenance_invalid', error);
  }
  let artifacts: readonly StructuredArtifact[];
  try {
    artifacts = normalizeSpecialistArtifacts(input.role, submitted.artifacts, providerRevision);
    assertSpecialistArtifactPolicy(input.role, artifacts);
    if (input.role === 'editor') {
      await input.assertEditProposals(
        artifacts.map(({ content }) =>
          typeof content.proposalId === 'string' ? content.proposalId : '',
        ),
      );
    }
  } catch (error) {
    throw new SpecialistSubmissionError('task_artifact_invalid', error);
  }
  try {
    await input.assertEvidence(artifacts.flatMap((artifact) => artifact.evidenceIds));
  } catch (error) {
    throw new SpecialistSubmissionError('task_evidence_invalid', error);
  }
  return { ...submitted, artifacts };
}
