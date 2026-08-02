import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from '@agentpress/database';

const MAX_CONCURRENT_REQUESTS = 8;

export class ArkEmbeddingProvider {
  public constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly model: string;
    },
  ) {}

  public async embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]> {
    if (texts.length === 0 || texts.length > 100)
      throw new RangeError('Embedding batch must contain between 1 and 100 texts');

    const vectors = new Array<number[]>(texts.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < texts.length) {
        const index = nextIndex++;
        const text = texts[index];
        if (text === undefined) continue;
        vectors[index] = await this.embedOne(text, signal);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, texts.length) }, () => worker()),
    );
    return vectors;
  }

  private async embedOne(text: string, signal?: AbortSignal): Promise<number[]> {
    const response = await fetch(
      `${this.options.baseUrl.replace(/\/$/u, '')}/embeddings/multimodal`,
      {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          input: [{ type: 'text', text }],
          dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
          encoding_format: 'float',
        }),
      },
    );
    if (!response.ok) throw new Error(`Ark embedding request failed (${String(response.status)})`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.embedding))
      throw new Error('Ark embedding response is invalid');
    const vector = payload.data.embedding.filter(
      (value: unknown): value is number => typeof value === 'number',
    );
    if (vector.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS)
      throw new Error(
        `Ark embedding response must contain a ${String(KNOWLEDGE_EMBEDDING_DIMENSIONS)}-dimensional vector`,
      );
    return vector;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
