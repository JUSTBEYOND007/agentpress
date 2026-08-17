import { describe, expect, it, vi } from 'vitest';

import { taskCompleteSchemaForRole } from '../src/planned-run-protocol.js';
import { validateSpecialistSubmission } from '../src/specialist-submission-validator.js';

const validWriterSubmission = {
  status: 'succeeded' as const,
  summary: 'Draft complete',
  artifacts: [
    {
      type: 'ArticleDraft' as const,
      title: 'Draft',
      summary: 'Draft summary',
      content: {},
      evidenceIds: [],
    },
  ],
  warnings: [],
};

describe('Specialist submission validator', () => {
  it('keeps schema, Artifact, Evidence, and provenance failures distinct', async () => {
    await expect(
      validateSpecialistSubmission({
        ...baseInput('writer'),
        value: { invalid: true },
      }),
    ).rejects.toMatchObject({ code: 'task_result_schema_invalid' });
    await expect(
      validateSpecialistSubmission({
        ...baseInput('writer'),
        value: {
          ...validWriterSubmission,
          artifacts: [{ ...validWriterSubmission.artifacts[0], type: 'AssetProposal' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'task_artifact_invalid' });
    await expect(
      validateSpecialistSubmission({
        ...baseInput('writer'),
        assertEvidence: () => Promise.reject(new Error('cross-task evidence')),
        value: validWriterSubmission,
      }),
    ).rejects.toMatchObject({ code: 'task_evidence_invalid' });
    await expect(
      validateSpecialistSubmission({
        ...baseInput('researcher'),
        resolveEvidenceProviderRevision: () => Promise.reject(new Error('mixed provider')),
        value: {
          status: 'succeeded',
          summary: 'Research complete',
          artifacts: [
            {
              type: 'ResearchBrief',
              title: 'Brief',
              summary: 'Brief summary',
              content: {
                schemaVersion: 1,
                purpose: 'general',
                depth: 'quick',
                claims: [],
                conflicts: [],
                unknowns: [],
                implications: [],
                sources: [
                  {
                    evidenceId: '0195557f-1696-4af7-a7a6-30e7c35a4682',
                    title: 'Source',
                  },
                ],
                queryLog: [],
                partialFailures: [],
              },
            },
          ],
          warnings: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'task_evidence_provenance_invalid' });
  });

  it('returns a normalized valid submission without changing ownership', async () => {
    await expect(
      validateSpecialistSubmission({ ...baseInput('writer'), value: validWriterSubmission }),
    ).resolves.toEqual(validWriterSubmission);
  });

  it('requires Editor proposals to belong to the current Task fact chain', async () => {
    const proposalId = '87041c56-dd38-45a1-9c67-37c63c3e9062';
    const value = {
      status: 'succeeded' as const,
      summary: 'Proposal complete',
      artifacts: [
        {
          type: 'EditProposal' as const,
          title: 'Edit proposal',
          summary: 'Reviewable article correction',
          content: { proposalId },
          evidenceIds: [],
        },
      ],
      warnings: [],
    };
    const valid = baseInput('editor');

    await expect(validateSpecialistSubmission({ ...valid, value })).resolves.toEqual(value);
    expect(valid.assertEditProposals).toHaveBeenCalledWith([proposalId]);
    await expect(
      validateSpecialistSubmission({
        ...baseInput('editor'),
        assertEditProposals: () => Promise.reject(new Error('foreign task proposal')),
        value,
      }),
    ).rejects.toMatchObject({ code: 'task_artifact_invalid' });
  });
});

function baseInput(role: 'writer' | 'researcher' | 'editor') {
  return {
    schema: taskCompleteSchemaForRole(role),
    role,
    resolveEvidenceProviderRevision: vi.fn(() => Promise.resolve(undefined)),
    assertEvidence: vi.fn(() => Promise.resolve()),
    assertEditProposals: vi.fn(() => Promise.resolve()),
  };
}
