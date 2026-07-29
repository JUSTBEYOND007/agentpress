import { randomUUID } from 'node:crypto';

import { Client } from 'minio';
import { afterAll, describe, expect, it } from 'vitest';

import { MinioObjectStorage } from '../src/index.js';

const endpoint = process.env.S3_ENDPOINT;
const describeWithMinio = endpoint ? describe : describe.skip;

describeWithMinio('MinioObjectStorage', () => {
  const url = new URL(endpoint ?? 'http://localhost:9000');
  const options = {
    endPoint: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? '443' : '80')),
    useSSL: url.protocol === 'https:',
    accessKey: process.env.S3_ACCESS_KEY ?? 'agentpress',
    secretKey: process.env.S3_SECRET_KEY ?? 'agentpress-local-secret',
    bucket: `agentpress-test-${randomUUID()}`,
  };
  const objectKey = 'media/checksum.png';
  const client = new Client(options);
  const storage = new MinioObjectStorage(options);

  afterAll(async () => {
    if (await client.bucketExists(options.bucket)) {
      await client.removeObject(options.bucket, objectKey);
      await client.removeBucket(options.bucket);
    }
  });

  it('round-trips immutable image bytes and content type', async () => {
    const bytes = Buffer.from('real-minio-image-bytes');

    await storage.put(objectKey, bytes, 'image/png');

    await expect(storage.get(objectKey)).resolves.toEqual({ bytes, mimeType: 'image/png' });
  });
});
