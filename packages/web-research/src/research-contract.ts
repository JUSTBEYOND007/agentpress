import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

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

const nonEmptyText = (maxLength: number) =>
  Type.String({ minLength: 1, maxLength, pattern: '\\S' });
const evidenceIdSchema = Type.String({
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});
const confidenceSchema = Type.Number({ minimum: 0, maximum: 1 });

export const researchBriefLimits = {
  maxClaims: 20,
  maxSources: 24,
  maxQueries: 8,
  maxEvidencePerClaim: 24,
  maxListItems: 20,
} as const;

const boundedTextList = Type.Array(nonEmptyText(2_000), {
  maxItems: researchBriefLimits.maxListItems,
});

export const researchClaimSchema = Type.Object(
  {
    text: nonEmptyText(2_000),
    evidenceIds: Type.Array(evidenceIdSchema, {
      minItems: 1,
      maxItems: researchBriefLimits.maxEvidencePerClaim,
    }),
    confidence: confidenceSchema,
  },
  { additionalProperties: false },
);

export const researchBriefSourceSchema = Type.Object(
  {
    evidenceId: evidenceIdSchema,
    title: nonEmptyText(500),
    sourceUri: Type.Optional(nonEmptyText(4_000)),
  },
  { additionalProperties: false },
);

export const researchQueryLogEntrySchema = Type.Object(
  {
    query: nonEmptyText(1_000),
    resultCount: Type.Integer({ minimum: 0, maximum: 100_000 }),
  },
  { additionalProperties: false },
);

/** Canonical persisted and model-output contract for ResearchBrief content. */
export const researchBriefContentSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    purpose: Type.Union(researchPurposes.map((purpose) => Type.Literal(purpose))),
    depth: Type.Union(researchDepths.map((depth) => Type.Literal(depth))),
    summary: nonEmptyText(4_000),
    claims: Type.Array(researchClaimSchema, { maxItems: researchBriefLimits.maxClaims }),
    conflicts: boundedTextList,
    unknowns: boundedTextList,
    implications: boundedTextList,
    sources: Type.Array(researchBriefSourceSchema, { maxItems: researchBriefLimits.maxSources }),
    confidence: confidenceSchema,
    queryLog: Type.Array(researchQueryLogEntrySchema, { maxItems: researchBriefLimits.maxQueries }),
    partialFailures: boundedTextList,
    providerRevision: nonEmptyText(160),
  },
  { additionalProperties: false },
);

export const researchBriefSubmissionSchema = Type.Object(
  {
    ...researchBriefContentSchema.properties,
    summary: Type.Optional(researchBriefContentSchema.properties.summary),
    confidence: Type.Optional(researchBriefContentSchema.properties.confidence),
  },
  { additionalProperties: false },
);

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ResearchClaim = DeepReadonly<Static<typeof researchClaimSchema>>;
export type ResearchBriefSource = DeepReadonly<Static<typeof researchBriefSourceSchema>>;
export type ResearchBriefContent = DeepReadonly<Static<typeof researchBriefContentSchema>>;
export type ResearchBriefSubmission = DeepReadonly<Static<typeof researchBriefSubmissionSchema>>;

export function normalizeResearchBriefSubmission(
  value: unknown,
  fallbackSummary: string,
): ResearchBriefContent {
  if (!Value.Check(researchBriefSubmissionSchema, value)) {
    throwStructuralError(researchBriefSubmissionSchema, value, 'submission');
  }
  const summary = value.summary ?? fallbackSummary.trim();
  const confidence = value.confidence ?? deriveSubmissionConfidence(value);
  const content = { ...value, summary, confidence };
  assertResearchBriefContent(content);
  return content;
}

export function assertResearchBriefContent(value: unknown): asserts value is ResearchBriefContent {
  if (!Value.Check(researchBriefContentSchema, value)) {
    throwStructuralError(researchBriefContentSchema, value, 'content');
  }

  const sourceIds = new Set<string>();
  for (const source of value.sources) {
    if (sourceIds.has(source.evidenceId)) {
      throw new TypeError('ResearchBrief sources must be unique');
    }
    sourceIds.add(source.evidenceId);
  }
  for (const claim of value.claims) {
    if (claim.evidenceIds.some((id) => !sourceIds.has(id))) {
      throw new TypeError('ResearchBrief claims may reference only listed Evidence IDs');
    }
  }
  if ((value.conflicts.length > 0 || value.partialFailures.length > 0) && value.confidence >= 1) {
    throw new TypeError(
      'ResearchBrief with conflicts or partial failures cannot claim full confidence',
    );
  }
}

/** Keeps the canonical source directory and persisted Artifact Evidence edges identical. */
export function assertResearchBriefEvidenceClosure(
  content: ResearchBriefContent,
  artifactEvidenceIds: readonly string[],
): void {
  const sourceIds = new Set(content.sources.map(({ evidenceId }) => evidenceId));
  const outerIds = new Set(artifactEvidenceIds);
  if (outerIds.size !== artifactEvidenceIds.length) {
    throw new TypeError('ResearchBrief Artifact Evidence IDs must be unique');
  }
  if (
    sourceIds.size !== outerIds.size ||
    [...sourceIds].some((evidenceId) => !outerIds.has(evidenceId))
  ) {
    throw new TypeError('ResearchBrief sources must exactly match the Artifact Evidence IDs');
  }
}

function deriveSubmissionConfidence(value: ResearchBriefSubmission): number {
  const claimConfidence =
    value.claims.length === 0 ? 0 : Math.min(...value.claims.map(({ confidence }) => confidence));
  return value.conflicts.length > 0 || value.partialFailures.length > 0
    ? Math.min(claimConfidence, 0.99)
    : claimConfidence;
}

function throwStructuralError(
  schema: typeof researchBriefContentSchema | typeof researchBriefSubmissionSchema,
  value: unknown,
  label: string,
): never {
  const firstError = Value.Errors(schema, value).First();
  const path = firstError?.path ?? '/';
  const message = firstError?.message ?? 'unknown schema violation';
  throw new TypeError(`ResearchBrief ${label} structure is invalid at ${path}: ${message}`);
}
