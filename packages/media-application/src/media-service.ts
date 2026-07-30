import { createHash, randomUUID } from 'node:crypto';

import {
  agentRuns,
  mediaAssets,
  rootRequests,
  toolCalls,
  type AgentPressDatabase,
} from '@agentpress/database';
import { and, eq } from 'drizzle-orm';

import type { ImageGenerator, ObjectStorage } from './contracts.js';

export class MediaService {
  public constructor(
    private readonly options: {
      readonly database: AgentPressDatabase;
      readonly storage: ObjectStorage;
      readonly imageGenerator: ImageGenerator;
      readonly createId?: () => string;
    },
  ) {}

  public async generateForTool(input: {
    readonly toolCallId: string;
    readonly prompt: string;
  }) {
    const approved = await this.options.database
      .select({ workspaceId: agentRuns.workspaceId, userId: rootRequests.requestedByUserId })
      .from(toolCalls)
      .innerJoin(agentRuns, eq(agentRuns.id, toolCalls.runId))
      .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
      .where(
        and(
          eq(toolCalls.id, input.toolCallId),
          eq(toolCalls.status, 'executing'),
          eq(toolCalls.toolId, 'image.generate'),
        ),
      )
      .limit(1);
    if (!approved[0]?.userId) throw new Error('Image generation requires an executing Tool Call');
    const artifact = await this.options.imageGenerator.generate(input.prompt);
    return this.persist({
      workspaceId: approved[0].workspaceId,
      userId: approved[0].userId,
      approvedToolCallId: input.toolCallId,
      kind: 'generated',
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
      prompt: input.prompt,
      model: artifact.model,
      ...(artifact.sourceUrl ? { sourceUrl: artifact.sourceUrl } : {}),
      ...(artifact.width === undefined ? {} : { width: artifact.width }),
      ...(artifact.height === undefined ? {} : { height: artifact.height }),
    });
  }

  public async importLicensed(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly bytes: Buffer;
    readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    readonly sourceUrl: string;
    readonly license: string;
    readonly attribution: string;
  }) {
    if (!input.sourceUrl.startsWith('https://') || !input.license || !input.attribution) {
      throw new Error('Licensed media requires secure source, license and attribution');
    }
    return this.persist({ ...input, kind: 'licensed' as const });
  }

  public async read(assetId: string) {
    const rows = await this.options.database
      .select({ objectKey: mediaAssets.objectKey, mimeType: mediaAssets.mimeType })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.options.storage.get(rows[0].objectKey);
  }

  public list(workspaceId: string) {
    return this.options.database
      .select({
        id: mediaAssets.id,
        kind: mediaAssets.kind,
        mimeType: mediaAssets.mimeType,
        checksum: mediaAssets.checksum,
        sourceUrl: mediaAssets.sourceUrl,
        license: mediaAssets.license,
        attribution: mediaAssets.attribution,
        prompt: mediaAssets.prompt,
        model: mediaAssets.model,
        createdAt: mediaAssets.createdAt,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.workspaceId, workspaceId));
  }

  private async persist(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly kind: 'generated' | 'licensed';
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly approvedToolCallId?: string;
    readonly sourceUrl?: string;
    readonly license?: string;
    readonly attribution?: string;
    readonly prompt?: string;
    readonly model?: string;
    readonly width?: number;
    readonly height?: number;
  }) {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > 15 * 1024 * 1024) {
      throw new Error('Media byte size is invalid');
    }
    const id = (this.options.createId ?? randomUUID)();
    const checksum = createHash('sha256').update(input.bytes).digest('hex');
    const extension =
      input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const objectKey = `${input.workspaceId}/${checksum}.${extension}`;
    await this.options.storage.put(objectKey, input.bytes, input.mimeType);
    await this.options.database.insert(mediaAssets).values({
      id,
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      approvedToolCallId: input.approvedToolCallId,
      kind: input.kind,
      objectKey,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      width: input.width,
      height: input.height,
      sourceUrl: input.sourceUrl,
      license: input.license,
      attribution: input.attribution,
      prompt: input.prompt,
      model: input.model,
    });
    return {
      id,
      assetId: id,
      contentUrl: `/v1/media/${id}/content`,
      objectKey,
      checksum,
      mimeType: input.mimeType,
      kind: input.kind,
      sourceUrl: input.sourceUrl,
      license: input.license,
      attribution: input.attribution,
      prompt: input.prompt,
      model: input.model,
    };
  }
}
