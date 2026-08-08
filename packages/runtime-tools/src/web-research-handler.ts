import {
  fetchResearchSource,
  ResearchFetchError,
  type ResearchFailure,
} from '@agentpress/web-research';

import { PublicSearchError, searchPublicSources } from './web-search.js';

type WebResearchSearchOptions = {
  readonly search?: typeof searchPublicSources;
  readonly fetchSource?: typeof fetchResearchSource;
};

export async function executeWebResearchSearch(
  input: { readonly query: string; readonly limit: number; readonly signal: AbortSignal },
  options: WebResearchSearchOptions = {},
) {
  const search = options.search ?? searchPublicSources;
  const fetchSource = options.fetchSource ?? fetchResearchSource;
  let sources;
  try {
    sources = await search(input.query, input.limit, { signal: input.signal });
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (error instanceof PublicSearchError) {
      return { results: [], failures: [error.toResearchFailure()] };
    }
    throw error;
  }
  const fetchedResults = await Promise.all(
    sources.map(async (source) => {
      try {
        const fetched = await fetchSource(source.url, {
          signal: input.signal,
          maxBytes: 750_000,
        });
        return {
          ...source,
          title: fetched.title,
          text: fetched.text.slice(0, 20_000),
          fetchedAt: fetched.fetchedAt,
        };
      } catch (error) {
        if (input.signal.aborted) throw error;
        return {
          source,
          failure: {
            kind: error instanceof ResearchFetchError ? error.kind : ('fetch_failed' as const),
            detail: error instanceof Error ? error.message : 'Source extraction failed',
            url: source.url,
          },
        };
      }
    }),
  );
  const results = fetchedResults.filter(
    (result): result is Exclude<(typeof fetchedResults)[number], { readonly failure: unknown }> =>
      !('failure' in result),
  );
  const failures: ResearchFailure[] = fetchedResults.flatMap((result) =>
    'failure' in result ? [result.failure] : [],
  );
  if (sources.length > 0 && results.length === 0) {
    failures.push({
      kind: 'all_sources_failed',
      detail: 'All fetched research sources failed',
    });
  }
  return {
    results,
    failures,
  };
}
