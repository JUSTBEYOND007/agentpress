import type { ImageArtifact, ImageGenerator } from './contracts.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export class ArkImageGenerator implements ImageGenerator {
  public constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly model: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  public async generate(prompt: string): Promise<ImageArtifact> {
    if (!prompt.trim() || prompt.length > 4_000) throw new Error('Image prompt is invalid');
    const request = this.options.fetch ?? fetch;
    const response = await request(
      `${this.options.baseUrl.replace(/\/$/, '')}/images/generations`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          prompt,
          response_format: 'url',
          size: '2048x2048',
          watermark: false,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Ark image generation failed with ${String(response.status)}`);
    const payload = recordValue((await response.json()) as unknown);
    const first = Array.isArray(payload.data) ? recordValue(payload.data[0]) : {};
    const url = typeof first.url === 'string' ? first.url : undefined;
    if (!url?.startsWith('https://')) throw new Error('Ark image response omitted a secure URL');
    const image = await request(url, { redirect: 'error' });
    if (!image.ok) throw new Error(`Generated image download failed with ${String(image.status)}`);
    const mimeType = normalizeMime(image.headers.get('content-type'));
    const declared = Number(image.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds size limit');
    const bytes = Buffer.from(await image.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('Generated image has an invalid size');
    }
    return { bytes, mimeType, model: this.options.model, sourceUrl: url };
  }
}

function normalizeMime(value: string | null): ImageArtifact['mimeType'] {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp') return mime;
  throw new Error('Generated image has an unsupported media type');
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
