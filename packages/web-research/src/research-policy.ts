import {
  researchBriefLimits,
  type ResearchBriefContent,
  type ResearchDepth,
  type ResearchPurpose,
} from './research-contract.js';

export type ResearchSearchHit = {
  readonly title: string;
  readonly url: string;
  readonly excerpt: string;
  readonly provider: string;
};
export type ResearchFetchedSource = {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly text: string;
  readonly contentType: string;
  readonly fetchedAt: string;
};
export type ResearchSearchPort = {
  readonly search: (
    query: string,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<readonly ResearchSearchHit[]>;
};
export type ResearchFetchPort = {
  readonly fetch: (url: string, signal?: AbortSignal) => Promise<ResearchFetchedSource>;
};
export type ResearchSynthesisPort = {
  readonly synthesize: (
    input: {
      readonly purpose: ResearchPurpose;
      readonly depth: ResearchDepth;
      readonly queryLog: readonly { readonly query: string; readonly resultCount: number }[];
      readonly sources: readonly ResearchFetchedSource[];
      readonly partialFailures: readonly string[];
    },
    signal?: AbortSignal,
  ) => Promise<ResearchBriefContent>;
};

export type ResearchExecutionPolicy = {
  readonly maxQueries: number;
  readonly resultsPerQuery: number;
  readonly maxSources: number;
  readonly fetchConcurrency: number;
  readonly maxSourceBytes: number;
  readonly maxSynthesisTokens: number;
};

export type ResearchPlan = {
  readonly purpose: ResearchPurpose;
  readonly depth: ResearchDepth;
  readonly queries: readonly string[];
  readonly policy: ResearchExecutionPolicy;
};

const policies: Readonly<Record<ResearchDepth, ResearchExecutionPolicy>> = {
  quick: {
    maxQueries: 2,
    resultsPerQuery: 2,
    maxSources: 5,
    fetchConcurrency: 2,
    maxSourceBytes: 500_000,
    maxSynthesisTokens: 2_500,
  },
  standard: {
    maxQueries: 4,
    resultsPerQuery: 2,
    maxSources: 12,
    fetchConcurrency: 4,
    maxSourceBytes: 1_000_000,
    maxSynthesisTokens: 4_000,
  },
  deep: {
    maxQueries: researchBriefLimits.maxQueries,
    resultsPerQuery: 2,
    maxSources: researchBriefLimits.maxSources,
    fetchConcurrency: 6,
    maxSourceBytes: 1_000_000,
    maxSynthesisTokens: 6_000,
  },
};

export function researchExecutionPolicy(depth: ResearchDepth): ResearchExecutionPolicy {
  return policies[depth];
}

export function createResearchPlan(input: {
  readonly topic: string;
  readonly purpose: ResearchPurpose;
  readonly depth: ResearchDepth;
  readonly expandedQueries?: readonly string[];
}): ResearchPlan {
  const topic = normalizeQuery(input.topic);
  if (!topic) throw new TypeError('Research topic is required');
  const policy = policies[input.depth];
  const queries = uniqueQueries([topic, ...(input.expandedQueries ?? [])]).slice(
    0,
    policy.maxQueries,
  );
  return { purpose: input.purpose, depth: input.depth, queries, policy };
}

export function deduplicateResearchHits(
  hits: readonly ResearchSearchHit[],
  maxSources: number,
): readonly ResearchSearchHit[] {
  if (!Number.isSafeInteger(maxSources) || maxSources < 1) {
    throw new RangeError('Research source budget must be positive');
  }
  const unique = new Map<string, ResearchSearchHit>();
  for (const hit of hits) {
    const key = canonicalResearchUrl(hit.url);
    if (!unique.has(key)) unique.set(key, hit);
    if (unique.size >= maxSources) break;
  }
  return [...unique.values()];
}

function uniqueQueries(queries: readonly string[]): readonly string[] {
  const unique = new Map<string, string>();
  for (const query of queries) {
    const normalized = normalizeQuery(query);
    if (normalized && !unique.has(normalized.toLocaleLowerCase())) {
      unique.set(normalized.toLocaleLowerCase(), normalized);
    }
  }
  return [...unique.values()];
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function canonicalResearchUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLocaleLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}
