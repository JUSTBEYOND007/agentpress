import { assertSafeUrl, type DnsAddress } from './ssrf-guard.js';
import { parse } from 'parse5';
import { extractText, getDocumentProxy } from 'unpdf';

const MAX_PDF_PAGES = 200;

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
  const isPdf = contentType.includes('application/pdf');
  if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !isPdf) {
    throw new Error(`Unsupported research content type: ${contentType}`);
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error(`Research source exceeds ${String(maxBytes)} bytes`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Research source exceeds ${String(maxBytes)} bytes`);
  }
  const extracted = isPdf
    ? await extractPdf(buffer)
    : extractTextContent(new TextDecoder().decode(buffer), current.hostname);
  return {
    url: rawUrl,
    finalUrl: current.toString(),
    title: extracted.title,
    text: extracted.text,
    contentType,
    fetchedAt: new Date().toISOString(),
  };
}

async function extractPdf(
  buffer: ArrayBuffer,
): Promise<{ readonly title: string; readonly text: string }> {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 5 || new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('Research PDF has an invalid file signature');
  }
  const document = await getDocumentProxy(bytes);
  if (document.numPages > MAX_PDF_PAGES) {
    throw new Error(`Research PDF exceeds ${String(MAX_PDF_PAGES)} pages`);
  }
  const result = await extractText(document, { mergePages: true });
  return {
    title: 'PDF document',
    text: typeof result.text === 'string' ? result.text.trim() : '',
  };
}

function extractTextContent(
  raw: string,
  fallbackTitle: string,
): { readonly title: string; readonly text: string } {
  const document = parse(raw);
  const title = findElementText(document, 'title') || fallbackTitle;
  const text = collectHtmlText(document).replace(/\s+/gu, ' ').trim();
  return { title, text };
}

function findElementText(value: unknown, elementName: string): string {
  if (!isHtmlNode(value)) return '';
  if (value.nodeName === elementName) return collectHtmlText(value).trim();
  for (const child of value.childNodes ?? []) {
    const found = findElementText(child, elementName);
    if (found) return found;
  }
  return '';
}

function collectHtmlText(value: unknown, excluded = false): string {
  if (!isHtmlNode(value)) return '';
  const hidden = excluded || ['script', 'style', 'noscript', 'template'].includes(value.nodeName);
  if (hidden) return '';
  if (value.nodeName === '#text') return typeof value.value === 'string' ? value.value : '';
  return (value.childNodes ?? [])
    .map((child) => collectHtmlText(child))
    .filter(Boolean)
    .join(' ');
}

function isHtmlNode(value: unknown): value is {
  readonly nodeName: string;
  readonly value?: unknown;
  readonly childNodes?: readonly unknown[];
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeName' in value &&
    typeof value.nodeName === 'string'
  );
}

export async function fetchPublicImage(
  rawUrl: string,
  options: {
    readonly maxBytes?: number;
    readonly maxRedirects?: number;
    readonly signal?: AbortSignal;
    readonly lookup?: (hostname: string) => Promise<readonly DnsAddress[]>;
    readonly fetch?: typeof fetch;
  } = {},
): Promise<{
  readonly bytes: Buffer;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly finalUrl: string;
}> {
  const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
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
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location || redirect === maxRedirects)
      throw new Error('Image redirect chain is invalid or too long');
    current = await validate(new URL(location, current).toString());
  }
  if (!response?.ok) throw new Error(`Image source returned HTTP ${String(response?.status ?? 0)}`);
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (contentType !== 'image/png' && contentType !== 'image/jpeg' && contentType !== 'image/webp')
    throw new Error(`Unsupported image content type: ${contentType ?? ''}`);
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error(`Image source exceeds ${String(maxBytes)} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes)
    throw new Error(`Image source exceeds ${String(maxBytes)} bytes or is empty`);
  return { bytes, mimeType: contentType, finalUrl: current.toString() };
}
