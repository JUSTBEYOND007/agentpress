import { describe, expect, it } from 'vitest';

import { assertResearchBriefContent, type ResearchBriefContent } from '../src/index.js';

const valid: ResearchBriefContent = {
  schemaVersion: 1,
  purpose: 'fact-check',
  depth: 'standard',
  summary: 'Evidence-backed summary',
  claims: [{ text: 'Claim', evidenceIds: ['evidence-1'], confidence: 0.8 }],
  conflicts: [],
  unknowns: ['One unresolved detail'],
  implications: ['Use a cautious conclusion'],
  sources: [{ evidenceId: 'evidence-1', title: 'Source' }],
  confidence: 0.8,
  queryLog: [{ query: 'query', resultCount: 2 }],
  partialFailures: [],
  providerRevision: 'research-policy-v1',
};

describe('ResearchBrief contract', () => {
  it('requires typed purpose/depth, Evidence-backed claims, and provenance', () => {
    expect(() => { assertResearchBriefContent(valid); }).not.toThrow();
    expect(() => { assertResearchBriefContent({ ...valid, claims: [{ ...valid.claims[0], evidenceIds: [] }] }); }).toThrow(/Evidence/u);
  });

  it('does not equate source count with confidence when research is degraded', () => {
    expect(() => { assertResearchBriefContent({ ...valid, partialFailures: ['fetch failed'], confidence: 1 }); }).toThrow(/full confidence/u);
    expect(() => { assertResearchBriefContent({ ...valid, conflicts: ['Source A disagrees'], confidence: 0.7 }); }).not.toThrow();
  });
});
