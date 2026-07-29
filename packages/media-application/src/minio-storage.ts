import { Client } from 'minio';

import type { ObjectStorage } from './contracts.js';

const MAX_STORED_BYTES = 20 * 1024 * 1024;

export class MinioObjectStorage implements ObjectStorage {
  private initialized: Promise<void> | undefined;
  private readonly client: Client;

  public constructor(
    private readonly options: {
      readonly endPoint: string;
      readonly port: number;
      readonly useSSL: boolean;
      readonly accessKey: string;
      readonly secretKey: string;
      readonly bucket: string;
    },
  ) {
    this.client = new Client(options);
  }

  public async put(objectKey: string, bytes: Buffer, mimeType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.putObject(this.options.bucket, objectKey, bytes, bytes.byteLength, {
      'content-type': mimeType,
      'cache-control': 'public, max-age=31536000, immutable',
    });
  }

  public async get(
    objectKey: string,
  ): Promise<{ readonly bytes: Buffer; readonly mimeType: string }> {
    const stat = await this.client.statObject(this.options.bucket, objectKey);
    if (stat.size > MAX_STORED_BYTES) throw new Error('Stored media exceeds response limit');
    const stream = await this.client.getObject(this.options.bucket, objectKey);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_STORED_BYTES) throw new Error('Stored media exceeds response limit');
      chunks.push(buffer);
    }
    const contentType: unknown = stat.metaData['content-type'];
    return {
      bytes: Buffer.concat(chunks),
      mimeType: typeof contentType === 'string' ? contentType : 'application/octet-stream',
    };
  }

  private ensureBucket(): Promise<void> {
    this.initialized ??= (async () => {
      if (!(await this.client.bucketExists(this.options.bucket))) {
        await this.client.makeBucket(this.options.bucket);
      }
    })();
    return this.initialized;
  }
}
