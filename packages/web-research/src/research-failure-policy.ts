import {
  assertResearchBriefContent,
  type ResearchBriefContent,
  type ResearchBriefSource,
  type ResearchDepth,
  type ResearchPurpose,
} from './research-contract.js';

/** Stable, provider-neutral failure vocabulary for Web Research projections. */
export const researchFailureKinds = [
  'missing_credentials',
  'zero_results',
  'duplicate_url',
  'redirect_private',
  'oversized_response',
  'unsupported_content_type',
  'fetch_failed',
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
  'synthesis_failed',
  'budget_exhausted',
  'persistence_failed',
  'conflicting_sources',
  'malicious_page_instructions',
  'all_sources_failed',
] as const;
export type ResearchFailureKind = (typeof researchFailureKinds)[number];

export type ResearchFailure = {
  readonly kind: ResearchFailureKind;
  readonly detail: string;
  readonly url?: string;
};

export type ResearchFailureAssessment = {
  readonly status: 'ok' | 'degraded' | 'failed';
  readonly sourceCount: number;
  readonly confidence: number;
  readonly partialFailures: readonly string[];
  readonly conflicts: readonly string[];
  readonly ignoredInstructions: readonly string[];
};

const terminalFailureKinds = new Set<ResearchFailureKind>([
  'synthesis_timeout',
  'synthesis_schema_invalid',
  'synthesis_failed',
  'budget_exhausted',
  'persistence_failed',
  'all_sources_failed',
]);

export function assessResearchFailures(input: {
  readonly sources: readonly { readonly url?: string; readonly sourceUri?: string }[];
  readonly failures?: readonly ResearchFailure[];
}): ResearchFailureAssessment {
  const failures = input.failures ?? [];
  const partialFailures = failures
    .filter(({ kind }) => kind !== 'conflicting_sources' && kind !== 'malicious_page_instructions')
    .map(formatFailure);
  const conflicts = failures
    .filter(({ kind }) => kind === 'conflicting_sources')
    .map(formatFailure);
  const ignoredInstructions = failures
    .filter(({ kind }) => kind === 'malicious_page_instructions')
    .map(formatFailure);
  const sourceCount = input.sources.length;
  const terminalFailure = failures.some(({ kind }) => terminalFailureKinds.has(kind));
  const confidence =
    sourceCount === 0 || terminalFailure
      ? 0
      : Math.max(
          0,
          Math.min(
            0.9,
            0.9 -
              partialFailures.length * 0.15 -
              conflicts.length * 0.2 -
              ignoredInstructions.length * 0.1,
          ),
        );
  return {
    status: terminalFailure ? 'failed' : failures.length > 0 ? 'degraded' : 'ok',
    sourceCount,
    confidence,
    partialFailures,
    conflicts,
    ignoredInstructions,
  };
}

/** Creates a valid, explicitly degraded artifact when search/fetch/synthesis cannot complete. */
export function buildDegradedResearchBrief(input: {
  readonly purpose: ResearchPurpose;
  readonly depth: ResearchDepth;
  readonly summary: string;
  readonly sources?: readonly ResearchBriefSource[];
  readonly queryLog?: readonly { readonly query: string; readonly resultCount: number }[];
  readonly failures: readonly ResearchFailure[];
  readonly providerRevision: string;
}): ResearchBriefContent {
  const sources = input.sources ?? [];
  const assessment = assessResearchFailures({ sources, failures: input.failures });
  const report: ResearchBriefContent = {
    schemaVersion: 1,
    purpose: input.purpose,
    depth: input.depth,
    summary: input.summary.trim() || 'Research could not produce a complete result.',
    claims: [],
    conflicts: assessment.conflicts,
    unknowns: input.failures.map(({ detail }) => detail),
    implications: ['Treat this result as incomplete and verify before relying on it.'],
    sources,
    confidence: assessment.confidence,
    queryLog: input.queryLog ?? [],
    partialFailures: [...assessment.partialFailures, ...assessment.ignoredInstructions],
    providerRevision: input.providerRevision,
  };
  assertResearchBriefContent(report);
  return report;
}

function formatFailure(failure: ResearchFailure): string {
  const location = failure.url ? ` (${failure.url})` : '';
  return `[${failure.kind}] ${failure.detail}${location}`;
}
