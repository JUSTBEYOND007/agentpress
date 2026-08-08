import { describe, expect, it } from 'vitest';

import {
  assessResearchFailures,
  buildDegradedResearchBrief,
  type ResearchFailure,
} from '../src/index.js';

const failure = (
  kind: ResearchFailure['kind'],
  detail?: string,
  url?: string,
): ResearchFailure => ({ kind, detail: detail ?? kind, ...(url ? { url } : {}) });

describe('provider-neutral research failure policy', () => {
  it('keeps no credentials and zero results explicitly degraded', () => {
    const report = buildDegradedResearchBrief({
      purpose: 'general',
      depth: 'quick',
      summary: '',
      providerRevision: 'test-v1',
      queryLog: [{ query: 'topic', resultCount: 0 }],
      failures: [
        failure('missing_credentials', 'Search provider credentials are unavailable'),
        failure('zero_results', 'No search results returned'),
      ],
    });
    expect(report.confidence).toBe(0);
    expect(report.claims).toEqual([]);
    expect(report.partialFailures).toHaveLength(2);
  });

  it('preserves fetch safety failures and does not trust malicious page instructions', () => {
    const assessment = assessResearchFailures({
      sources: [{ url: 'https://example.test/source' }],
      failures: [
        failure(
          'duplicate_url',
          'Canonical URL was already retained',
          'https://example.test/source',
        ),
        failure(
          'redirect_private',
          'Redirect target resolved to a private address',
          'https://example.test/private',
        ),
        failure('oversized_response'),
        failure('unsupported_content_type'),
        failure('malicious_page_instructions', 'Ignored instructions embedded in fetched page'),
      ],
    });
    expect(assessment.status).toBe('degraded');
    expect(assessment.ignoredInstructions).toHaveLength(1);
    expect(assessment.partialFailures.join(' ')).toMatch(/redirect_private/u);
    expect(assessment.partialFailures.join(' ')).not.toMatch(/malicious_page_instructions/u);
  });

  it('emits a failed but schema-valid report when every source fetch fails', () => {
    const report = buildDegradedResearchBrief({
      purpose: 'fact-check',
      depth: 'standard',
      summary: 'All source fetches failed',
      providerRevision: 'test-v1',
      sources: [],
      queryLog: [{ query: 'topic', resultCount: 2 }],
      failures: [
        failure('fetch_failed', 'Connection reset'),
        failure('all_sources_failed', 'No source could be fetched'),
      ],
    });
    expect(report.confidence).toBe(0);
    expect(report.sources).toEqual([]);
    expect(report.partialFailures).toHaveLength(2);
  });

  it('lowers confidence for conflicts and partial fetch failures', () => {
    const assessment = assessResearchFailures({
      sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }],
      failures: [
        failure('fetch_failed', 'timeout'),
        failure('conflicting_sources', 'Sources disagree'),
      ],
    });
    expect(assessment.status).toBe('degraded');
    expect(assessment.confidence).toBe(0.55);
    expect(assessment.conflicts).toEqual(['[conflicting_sources] Sources disagree']);
  });

  it('keeps execution-stage failures typed and claim-free', () => {
    const kinds: readonly ResearchFailure['kind'][] = [
      'search_failed',
      'search_timeout',
      'rate_limited',
      'provider_schema_invalid',
      'fetch_timeout',
      'fetch_cancelled',
      'dns_failure',
      'redirect_loop',
      'invalid_url',
      'empty_body',
      'pdf_signature_invalid',
      'pdf_page_limit',
      'synthesis_timeout',
      'synthesis_schema_invalid',
      'budget_exhausted',
      'persistence_failed',
    ];
    const report = buildDegradedResearchBrief({
      purpose: 'general',
      depth: 'quick',
      summary: 'Incomplete research',
      providerRevision: 'test-v1',
      failures: kinds.map((kind) => failure(kind)),
    });
    expect(report.claims).toEqual([]);
    expect(report.confidence).toBe(0);
    expect(report.partialFailures).toHaveLength(kinds.length);
    expect(report.unknowns).toHaveLength(kinds.length);
  });

  it('sets confidence to zero when synthesis fails after sources were retained', () => {
    const report = buildDegradedResearchBrief({
      purpose: 'fact-check',
      depth: 'deep',
      summary: 'Sources were retained but synthesis failed',
      providerRevision: 'test-v1',
      sources: [
        {
          evidenceId: '11111111-1111-4111-8111-111111111111',
          title: 'Retained source',
          sourceUri: 'https://example.test/source',
        },
      ],
      failures: [failure('synthesis_schema_invalid', 'The model result failed validation')],
    });

    expect(report.sources).toHaveLength(1);
    expect(report.claims).toEqual([]);
    expect(report.confidence).toBe(0);
    expect(
      assessResearchFailures({
        sources: report.sources,
        failures: [failure('synthesis_schema_invalid')],
      }).status,
    ).toBe('failed');
  });
});
