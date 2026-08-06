export const researchPurposes = [
  'worldbuilding',
  'era',
  'profession',
  'market',
  'fact-check',
  'general',
] as const;
export type ResearchPurpose = (typeof researchPurposes)[number];
export const researchDepths = ['quick', 'standard', 'deep'] as const;
export type ResearchDepth = (typeof researchDepths)[number];

export type ResearchClaim = {
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
};
export type ResearchBriefSource = {
  readonly evidenceId: string;
  readonly title: string;
  readonly sourceUri?: string;
};
export type ResearchBriefContent = {
  readonly schemaVersion: 1;
  readonly purpose: ResearchPurpose;
  readonly depth: ResearchDepth;
  readonly summary: string;
  readonly claims: readonly ResearchClaim[];
  readonly conflicts: readonly string[];
  readonly unknowns: readonly string[];
  readonly implications: readonly string[];
  readonly sources: readonly ResearchBriefSource[];
  readonly confidence: number;
  readonly queryLog: readonly { readonly query: string; readonly resultCount: number }[];
  readonly partialFailures: readonly string[];
  readonly providerRevision: string;
};

export function assertResearchBriefContent(value: unknown): asserts value is ResearchBriefContent {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new TypeError('ResearchBrief requires schemaVersion=1');
  }
  if (!researchPurposes.includes(value.purpose as ResearchPurpose)) {
    throw new TypeError('ResearchBrief purpose is invalid');
  }
  if (!researchDepths.includes(value.depth as ResearchDepth)) {
    throw new TypeError('ResearchBrief depth is invalid');
  }
  for (const key of ['summary', 'providerRevision'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new TypeError(`ResearchBrief ${key} is required`);
    }
  }
  for (const key of [
    'claims',
    'conflicts',
    'unknowns',
    'implications',
    'sources',
    'queryLog',
    'partialFailures',
  ] as const) {
    if (!Array.isArray(value[key])) throw new TypeError(`ResearchBrief ${key} must be an array`);
  }
  assertConfidence(value.confidence, 'ResearchBrief confidence');
  const confidence = value.confidence as number;
  const sourceIds = new Set<string>();
  const sources = value.sources as readonly unknown[];
  const claims = value.claims as readonly unknown[];
  const conflicts = value.conflicts as readonly unknown[];
  const partialFailures = value.partialFailures as readonly unknown[];
  for (const source of sources) {
    if (
      !isRecord(source) ||
      typeof source.evidenceId !== 'string' ||
      source.evidenceId.length === 0
    ) {
      throw new TypeError('ResearchBrief sources require Evidence IDs');
    }
    if (sourceIds.has(source.evidenceId))
      throw new TypeError('ResearchBrief sources must be unique');
    sourceIds.add(source.evidenceId);
  }
  for (const claim of claims) {
    if (!isRecord(claim) || typeof claim.text !== 'string' || claim.text.trim() === '') {
      throw new TypeError('ResearchBrief claims require text');
    }
    if (!Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0) {
      throw new TypeError('ResearchBrief claims require Evidence IDs');
    }
    if (claim.evidenceIds.some((id) => typeof id !== 'string' || !sourceIds.has(id))) {
      throw new TypeError('ResearchBrief claims may reference only listed Evidence IDs');
    }
    assertConfidence(claim.confidence, 'ResearchBrief claim confidence');
  }
  if ((conflicts.length > 0 || partialFailures.length > 0) && confidence >= 1) {
    throw new TypeError(
      'ResearchBrief with conflicts or partial failures cannot claim full confidence',
    );
  }
}

function assertConfidence(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be between 0 and 1`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
