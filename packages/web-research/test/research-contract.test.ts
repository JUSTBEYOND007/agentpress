import { describe, expect, it } from 'vitest';

import { Value } from '@sinclair/typebox/value';

import {
  assertResearchBriefContent,
  assertResearchBriefEvidenceClosure,
  normalizeResearchBriefSubmission,
  researchBriefContentSchema,
  researchBriefLimits,
  type ResearchBriefContent,
} from '../src/index.js';

const evidenceId = '0195557f-1696-4af7-a7a6-30e7c35a4682';
const otherEvidenceId = '1195557f-1696-4af7-a7a6-30e7c35a4682';
const missingEvidenceId = '2195557f-1696-4af7-a7a6-30e7c35a4682';

const valid: ResearchBriefContent = {
  schemaVersion: 1,
  purpose: 'fact-check',
  depth: 'standard',
  summary: 'Evidence-backed summary',
  claims: [{ text: 'Claim', evidenceIds: [evidenceId], confidence: 0.8 }],
  conflicts: [],
  unknowns: ['One unresolved detail'],
  implications: ['Use a cautious conclusion'],
  sources: [{ evidenceId, title: 'Source' }],
  confidence: 0.8,
  queryLog: [{ query: 'query', resultCount: 2 }],
  partialFailures: [],
  providerRevision: 'research-policy-v1',
};

describe('ResearchBrief contract', () => {
  it('exports a canonical strict schema that accepts a valid ResearchBrief', () => {
    expect(Value.Check(researchBriefContentSchema, valid)).toBe(true);
    expect(() => {
      assertResearchBriefContent(valid);
    }).not.toThrow();
  });

  it('requires schemaVersion and rejects arbitrary nested content', () => {
    const withoutSchemaVersion: Record<string, unknown> = { ...valid };
    delete withoutSchemaVersion.schemaVersion;

    expect(() => {
      assertResearchBriefContent(withoutSchemaVersion);
    }).toThrow(/schemaVersion/u);
    expect(() => {
      assertResearchBriefContent({
        ...valid,
        claims: [{ arbitraryTitle: 'arbitrary shape', nested: { conclusion: 'not a claim' } }],
      });
    }).toThrow(/structure is invalid/u);
    expect(() => {
      assertResearchBriefContent({ ...valid, unexpected: { nested: true } });
    }).toThrow(/structure is invalid/u);
  });

  it('rejects claims that reference Evidence IDs absent from sources', () => {
    expect(() => {
      assertResearchBriefContent({
        ...valid,
        claims: [{ ...valid.claims[0], evidenceIds: [missingEvidenceId] }],
      });
    }).toThrow(/only listed Evidence IDs/u);
  });

  it('retains cross-field uniqueness checks beyond structural validation', () => {
    expect(() => {
      assertResearchBriefContent({
        ...valid,
        sources: [...valid.sources, { evidenceId, title: 'Duplicate source' }],
      });
    }).toThrow(/sources must be unique/u);
  });

  it('bounds model-visible synthesis volume', () => {
    expect(
      Value.Check(researchBriefContentSchema, {
        ...valid,
        claims: Array.from({ length: researchBriefLimits.maxClaims + 1 }, () => valid.claims[0]),
      }),
    ).toBe(false);
  });

  it('normalizes omitted wire summary and confidence before canonical validation', () => {
    const submission: Record<string, unknown> = { ...valid };
    delete submission.summary;
    delete submission.confidence;
    delete submission.providerRevision;

    expect(
      normalizeResearchBriefSubmission(submission, 'Artifact summary', 'research-policy-v1'),
    ).toEqual({
      ...valid,
      summary: 'Artifact summary',
      confidence: 0.8,
    });
  });

  it('does not use wire normalization to bypass canonical Evidence semantics', () => {
    const submission: Record<string, unknown> = {
      ...valid,
      summary: undefined,
      confidence: undefined,
      claims: [{ ...valid.claims[0], evidenceIds: [missingEvidenceId] }],
    };
    delete submission.providerRevision;
    expect(() =>
      normalizeResearchBriefSubmission(submission, 'Artifact summary', 'research-policy-v1'),
    ).toThrow(/only listed Evidence IDs/u);
  });

  it('does not equate source count with confidence when research is degraded', () => {
    expect(() => {
      assertResearchBriefContent({ ...valid, partialFailures: ['fetch failed'], confidence: 1 });
    }).toThrow(/full confidence/u);
    expect(() => {
      assertResearchBriefContent({ ...valid, conflicts: ['Source A disagrees'], confidence: 0.7 });
    }).not.toThrow();
  });

  it('requires canonical sources and Artifact Evidence edges to form one exact set', () => {
    expect(() => {
      assertResearchBriefEvidenceClosure(valid, [evidenceId]);
    }).not.toThrow();
    expect(() => {
      assertResearchBriefEvidenceClosure(valid, []);
    }).toThrow(/exactly match/u);
    expect(() => {
      assertResearchBriefEvidenceClosure(valid, [evidenceId, otherEvidenceId]);
    }).toThrow(/exactly match/u);
    expect(() => {
      assertResearchBriefEvidenceClosure(valid, [evidenceId, evidenceId]);
    }).toThrow(/must be unique/u);
  });

  it('allows Claims to cite a subset of the closed source directory', () => {
    const content: ResearchBriefContent = {
      ...valid,
      sources: [...valid.sources, { evidenceId: otherEvidenceId, title: 'Background source' }],
    };

    expect(() => {
      assertResearchBriefContent(content);
    }).not.toThrow();
    expect(() => {
      assertResearchBriefEvidenceClosure(content, [otherEvidenceId, evidenceId]);
    }).not.toThrow();
  });
});
