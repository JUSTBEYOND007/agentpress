import { createHash, randomUUID } from 'node:crypto';

import { runAttachments, type AgentPressDatabase } from '@agentpress/database';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

import type { ObjectStorage } from './contracts.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
const MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
]);

export class AttachmentService {
  public constructor(
    private readonly options: {
      readonly database: AgentPressDatabase;
      readonly storage: ObjectStorage;
      readonly createId?: () => string;
    },
  ) {}

  public async upload(input: {
    readonly workspaceId: string;
    readonly uploadedByUserId: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly bytes: Buffer;
  }) {
    if (!MIME_TYPES.has(input.mimeType)) throw new Error('Unsupported attachment type');
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_BYTES) {
      throw new Error('Attachment must contain between 1 byte and 20MB');
    }
    const id = (this.options.createId ?? randomUUID)();
    const contentHash = createHash('sha256').update(input.bytes).digest('hex');
    const objectKey = `attachments/${input.workspaceId}/${id}/${safeFilename(input.filename)}`;
    await this.options.storage.put(objectKey, input.bytes, input.mimeType);
    let extractedText: string | undefined;
    let parseFailure: string | undefined;
    try {
      extractedText = await parseAttachment(input.bytes, input.mimeType);
    } catch (error) {
      parseFailure = error instanceof Error ? error.message : 'Attachment parsing failed';
    }
    await this.options.database.insert(runAttachments).values({
      id,
      workspaceId: input.workspaceId,
      uploadedByUserId: input.uploadedByUserId,
      filename: input.filename.slice(0, 300),
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      objectKey,
      contentHash,
      parseStatus: parseFailure ? 'failed' : 'ready',
      ...(extractedText === undefined ? {} : { extractedText }),
      ...(parseFailure ? { parseFailure } : {}),
    });
    return {
      id,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      contentHash,
      parseStatus: parseFailure ? ('failed' as const) : ('ready' as const),
      ...(parseFailure ? { parseFailure } : {}),
    };
  }
}

async function parseAttachment(bytes: Buffer, mimeType: string): Promise<string> {
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  }
  if (mimeType === 'application/pdf') {
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('PDF has an invalid file signature');
    }
    const document = await getDocumentProxy(new Uint8Array(bytes));
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF exceeds ${String(MAX_PDF_PAGES)} pages`);
    }
    const result = await extractText(document, { mergePages: true });
    return typeof result.text === 'string' ? result.text.trim() : '';
  }
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value.trim();
}

function safeFilename(filename: string): string {
  return (
    filename.normalize('NFKC').replaceAll('/', '_').replaceAll('\\', '_').slice(0, 180) || 'file'
  );
}
