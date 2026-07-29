import { assertSafeUrl, type DnsAddress } from './ssrf-guard.js';

export type ResearchSource = {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly text: string;
  readonly contentType: string;
  readonly fetchedAt: string;
};

export async function fetchResearchSource(
  rawUrl: string,
  options: {
    readonly maxBytes?: number;
    readonly maxRedirects?: number;
    readonly signal?: AbortSignal;
    readonly lookup?: (hostname: string) => Promise<readonly DnsAddress[]>;
    readonly fetch?: typeof fetch;
  } = {},
): Promise<ResearchSource> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const validate = (value: string): Promise<URL> =>
    assertSafeUrl(value, options.lookup ? { lookup: options.lookup } : {});
  let current = await validate(rawUrl);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    response = await (options.fetch ?? fetch)(current, {
      redirect: 'manual',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status < 300 || response.status >= 400) {
      break;
    }
    const location = response.headers.get('location');
    if (!location || redirect === maxRedirects) {
      throw new Error('Research redirect chain is invalid or too long');
    }
    current = await validate(new URL(location, current).toString());
  }
  if (!response?.ok) {
    throw new Error(`Research source returned HTTP ${String(response?.status ?? 0)}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw new Error(`Unsupported research content type: ${contentType}`);
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error(`Research source exceeds ${String(maxBytes)} bytes`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Research source exceeds ${String(maxBytes)} bytes`);
  }
  const raw = new TextDecoder().decode(buffer);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? current.hostname;
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    url: rawUrl,
    finalUrl: current.toString(),
    title,
    text,
    contentType,
    fetchedAt: new Date().toISOString(),
  };
}
