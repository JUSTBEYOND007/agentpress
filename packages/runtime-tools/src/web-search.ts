// Adapted from pi-web-access v0.15.0 anysearch.ts (MIT). See THIRD_PARTY_NOTICES.md.

export type PublicSearchResult = {
  readonly title: string;
  readonly url: string;
  readonly excerpt: string;
  readonly source: string;
};

type SearchOptions = {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
};

type AnySearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

const ANYSEARCH_API_URL = 'https://api.anysearch.com/v1/search';
const SEARCH_TIMEOUT_MS = 30_000;

type PublicSearchFailureKind =
  | 'search_failed'
  | 'search_timeout'
  | 'rate_limited'
  | 'provider_schema_invalid';

export class PublicSearchError extends Error {
  public override readonly name = 'PublicSearchError';

  public constructor(
    public readonly kind: PublicSearchFailureKind,
    message: string,
  ) {
    super(message);
  }

  public toResearchFailure(): { readonly kind: PublicSearchFailureKind; readonly detail: string } {
    return { kind: this.kind, detail: this.message };
  }
}

export async function searchPublicSources(
  query: string,
  limit: number,
  options: SearchOptions = {},
): Promise<readonly PublicSearchResult[]> {
  const request = options.fetch ?? fetch;
  const apiKey = options.apiKey ?? process.env.ANYSEARCH_API_KEY?.trim();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await request(options.baseUrl ?? ANYSEARCH_API_URL, {
      method: 'POST',
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, max_results: normalizeLimit(limit) }),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) {
      throw new PublicSearchError('search_timeout', 'Public search provider timed out');
    }
    throw new PublicSearchError('search_failed', 'Public search provider request failed');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) {
      throw new PublicSearchError('rate_limited', 'Public search provider rate limit exceeded');
    }
    throw new PublicSearchError(
      'search_failed',
      `Public search provider returned HTTP ${String(response.status)}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidResponse('expected JSON response');
  }
  const results = parseResponse(payload);
  return results.slice(0, normalizeLimit(limit)).map((result) => ({
    title: result.title,
    url: result.url,
    excerpt: result.snippet,
    source: 'AnySearch',
  }));
}

function parseResponse(value: unknown): readonly AnySearchResult[] {
  if (!isRecord(value) || value.code !== 0) {
    throw invalidResponse('expected an object envelope with code 0');
  }
  if (!isRecord(value.data) || !Array.isArray(value.data.results)) {
    throw invalidResponse('expected data.results array');
  }
  if (!isRecord(value.data.metadata)) {
    throw invalidResponse('expected data.metadata object');
  }
  return value.data.results.map((value, index) => {
    if (!isRecord(value)) throw invalidResponse(`expected data.results[${String(index)}] object`);
    const { title, url, snippet } = value;
    if (typeof title !== 'string') {
      throw invalidResponse(`expected data.results[${String(index)}].title string`);
    }
    if (typeof url !== 'string' || !url) {
      throw invalidResponse(`expected data.results[${String(index)}].url to be a non-empty string`);
    }
    if (typeof snippet !== 'string') {
      throw invalidResponse(`expected data.results[${String(index)}].snippet string`);
    }
    return { title, url, snippet };
  });
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(Math.floor(value), 20));
}

function invalidResponse(message: string): PublicSearchError {
  return new PublicSearchError(
    'provider_schema_invalid',
    `AnySearch API returned invalid response: ${message}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
