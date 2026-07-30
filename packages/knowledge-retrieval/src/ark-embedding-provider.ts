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
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/u, '')}/embeddings`, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.options.model, input: texts }),
    });
    if (!response.ok) throw new Error(`Ark embedding request failed (${String(response.status)})`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data))
      throw new Error('Ark embedding response is invalid');
    const vectors: number[][] = payload.data.map((item: unknown) => {
      if (!isRecord(item) || !Array.isArray(item.embedding)) return [];
      return item.embedding.filter((value: unknown): value is number => typeof value === 'number');
    });
    if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== 1536))
      throw new Error('Ark embedding response must contain one 1536-dimensional vector per input');
    return vectors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
