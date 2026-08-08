import { fetchResearchSource } from '@agentpress/web-research';

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
  const results = await Promise.all(
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
        return {
          ...source,
          fetchError: error instanceof Error ? error.message : 'Source extraction failed',
        };
      }
    }),
  );
  return {
    results,
    failures: results.flatMap((result) =>
      'fetchError' in result
        ? [{ kind: 'fetch_failed' as const, detail: result.fetchError, url: result.url }]
        : [],
    ),
  };
}
