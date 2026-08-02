import { XMLParser } from 'fast-xml-parser';

export type PublicSearchResult = {
  readonly title: string;
  readonly url: string;
  readonly excerpt: string;
  readonly source: string;
  readonly publishedAt?: string;
};

type SearchOptions = {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: false,
  trimValues: true,
});

export async function searchPublicSources(
  query: string,
  limit: number,
  options: SearchOptions = {},
): Promise<readonly PublicSearchResult[]> {
  const request = options.fetch ?? fetch;
  const [news, encyclopedia] = await Promise.allSettled([
    searchGoogleNews(query, limit, request, options.signal),
    searchWikipedia(query, limit, request, options.signal),
  ]);
  const merged = [
    ...(news.status === 'fulfilled' ? news.value : []),
    ...(encyclopedia.status === 'fulfilled' ? encyclopedia.value : []),
  ];
  const unique = new Map<string, PublicSearchResult>();
  for (const result of merged) {
    const key = canonicalUrl(result.url);
    if (!unique.has(key)) unique.set(key, result);
    if (unique.size >= limit) break;
  }
  if (unique.size === 0 && news.status === 'rejected' && encyclopedia.status === 'rejected') {
    throw new AggregateError(
      [news.reason, encyclopedia.reason],
      'All public search providers failed',
    );
  }
  return [...unique.values()];
}

async function searchGoogleNews(
  query: string,
  limit: number,
  request: typeof fetch,
  signal?: AbortSignal,
): Promise<readonly PublicSearchResult[]> {
  const endpoint = new URL('https://news.google.com/rss/search');
  endpoint.search = new URLSearchParams({
    q: query,
    hl: 'zh-CN',
    gl: 'CN',
    ceid: 'CN:zh-Hans',
  }).toString();
  const response = await request(endpoint, {
    ...(signal ? { signal } : {}),
    headers: { 'user-agent': 'AgentPress/0.1 (public research agent)' },
  });
  if (!response.ok) throw new Error(`Google News returned HTTP ${String(response.status)}`);
  return normalizeGoogleNews(parser.parse(await response.text()), limit);
}

async function searchWikipedia(
  query: string,
  limit: number,
  request: typeof fetch,
  signal?: AbortSignal,
): Promise<readonly PublicSearchResult[]> {
  const endpoint = new URL('https://zh.wikipedia.org/w/api.php');
  endpoint.search = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(limit),
    format: 'json',
    origin: '*',
  }).toString();
  const response = await request(endpoint, {
    ...(signal ? { signal } : {}),
    headers: { 'user-agent': 'AgentPress/0.1 (public research agent)' },
  });
  if (!response.ok) throw new Error(`Wikipedia returned HTTP ${String(response.status)}`);
  return normalizeWikipedia(await response.json());
}

function normalizeGoogleNews(value: unknown, limit: number): readonly PublicSearchResult[] {
  if (!isRecord(value) || !isRecord(value.rss) || !isRecord(value.rss.channel)) return [];
  const rawItems = value.rss.channel.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems === undefined ? [] : [rawItems];
  return items.slice(0, limit).flatMap((item) => {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.link !== 'string')
      return [];
    const source =
      typeof item.source === 'string'
        ? item.source
        : isRecord(item.source) && typeof item.source['#text'] === 'string'
          ? item.source['#text']
          : 'Google News';
    return [
      {
        title: item.title,
        url: item.link,
        excerpt: typeof item.description === 'string' ? stripTags(item.description) : '',
        source,
        ...(typeof item.pubDate === 'string' ? { publishedAt: item.pubDate } : {}),
      },
    ];
  });
}

function normalizeWikipedia(value: unknown): readonly PublicSearchResult[] {
  if (!isRecord(value) || !isRecord(value.query) || !Array.isArray(value.query.search)) return [];
  return value.query.search.flatMap((item) => {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.pageid !== 'number')
      return [];
    return [
      {
        title: item.title,
        url: `https://zh.wikipedia.org/?curid=${String(item.pageid)}`,
        excerpt: typeof item.snippet === 'string' ? stripTags(item.snippet) : '',
        source: 'Wikipedia',
      },
    ];
  });
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
