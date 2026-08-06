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
};

type AnySearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

const ANYSEARCH_API_URL = 'https://api.anysearch.com/v1/search';
const SEARCH_TIMEOUT_MS = 30_000;

export async function searchPublicSources(
  query: string,
  limit: number,
  options: SearchOptions = {},
): Promise<readonly PublicSearchResult[]> {
  const request = options.fetch ?? fetch;
  const apiKey = options.apiKey ?? process.env.ANYSEARCH_API_KEY?.trim();
  const response = await request(options.baseUrl ?? ANYSEARCH_API_URL, {
    method: 'POST',
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, max_results: normalizeLimit(limit) }),
    signal: options.signal
      ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
      : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = redactCredential((await response.text()).slice(0, 300), apiKey);
    throw new Error(`AnySearch API error ${String(response.status)}${detail ? `: ${detail}` : ''}`);
  }
  const results = parseResponse(await response.json());
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

function invalidResponse(message: string): Error {
  return new Error(`AnySearch API returned invalid response: ${message}`);
}

function redactCredential(value: string, credential: string | undefined): string {
  return credential ? value.replaceAll(credential, '[redacted]') : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
