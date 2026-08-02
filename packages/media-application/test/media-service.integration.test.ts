import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  agentRuns,
  appUsers,
  connectDatabase,
  conversationBranches,
  conversationMessages,
  conversations,
  mediaAssets,
  rootRequests,
  toolCalls,
  workspaces,
} from '@agentpress/database';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, describe, expect, it } from 'vitest';

import { MediaService, type ObjectStorage } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase('Agent image generation ledger', () => {
  const connection = connectDatabase(connectionString ?? '');
  afterAll(async () => connection.close());

  it('only generates for an executing image Tool Call and persists provenance', async () => {
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../../database/migrations', import.meta.url)),
    });
    const ids = {
      user: randomUUID(),
      workspace: randomUUID(),
      conversation: randomUUID(),
      branch: randomUUID(),
      message: randomUUID(),
      request: randomUUID(),
      run: randomUUID(),
      tool: randomUUID(),
    };
    await connection.db.insert(appUsers).values({
      id: ids.user,
      logtoSubject: `media|${ids.user}`,
      displayName: 'Media',
    });
    await connection.db.insert(workspaces).values({ id: ids.workspace, name: 'Media' });
    await connection.db.insert(conversations).values({
      id: ids.conversation,
      workspaceId: ids.workspace,
      title: 'Media',
    });
    await connection.db.insert(conversationBranches).values({
      id: ids.branch,
      conversationId: ids.conversation,
    });
    await connection.db.insert(conversationMessages).values({
      id: ids.message,
      branchId: ids.branch,
      role: 'user',
      sequence: 1,
      content: [],
      stable: true,
    });
    await connection.db.insert(rootRequests).values({
      id: ids.request,
      branchId: ids.branch,
      messageId: ids.message,
      requestedByUserId: ids.user,
      idempotencyKey: randomUUID(),
    });
    await connection.db.insert(agentRuns).values({
      id: ids.run,
      workspaceId: ids.workspace,
      branchId: ids.branch,
      rootRequestId: ids.request,
      mode: 'direct',
      status: 'running',
    });
    await connection.db.insert(toolCalls).values({
      id: ids.tool,
      runId: ids.run,
      toolId: 'image.generate',
      toolVersion: '1.0.0',
      arguments: { prompt: 'A Kafka diagram' },
      argumentsHash: 'hash',
      risk: 'external_write',
      sideEffect: 'generate',
      status: 'executing',
    });
    const stored = new Map<string, Buffer>();
    const storage: ObjectStorage = {
      put(key, bytes) {
        stored.set(key, bytes);
        return Promise.resolve();
      },
      get(key) {
        return Promise.resolve({
          bytes: stored.get(key) ?? Buffer.alloc(0),
          mimeType: 'image/png',
        });
      },
    };
    const service = new MediaService({
      database: connection.db,
      storage,
      imageGenerator: {
        generate: () =>
          Promise.resolve({ bytes: Buffer.from('png'), mimeType: 'image/png', model: 'ark-image' }),
      },
    });
    await expect(
      service.generateForTool({ toolCallId: ids.tool, prompt: 'A Kafka diagram' }),
    ).resolves.toMatchObject({ kind: 'generated', model: 'ark-image', prompt: 'A Kafka diagram' });
    const rows = await connection.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.approvedToolCallId, ids.tool));
    expect(rows[0]).toMatchObject({
      workspaceId: ids.workspace,
      createdByUserId: ids.user,
      model: 'ark-image',
    });

    const licensedToolId = randomUUID();
    const licensedSourceUrl = `https://commons.wikimedia.org/${licensedToolId}.png`;
    await connection.db.insert(toolCalls).values({
      id: licensedToolId,
      runId: ids.run,
      toolId: 'media.import_licensed',
      toolVersion: '1.0.0',
      arguments: {
        sourceUrl: licensedSourceUrl,
        license: 'CC BY 4.0',
        attribution: 'Example Author',
      },
      argumentsHash: 'licensed-hash',
      risk: 'external_write',
      sideEffect: 'import',
      status: 'executing',
    });
    await expect(
      service.importLicensedForTool({
        toolCallId: licensedToolId,
        bytes: Buffer.from('licensed-image'),
        mimeType: 'image/png',
        sourceUrl: licensedSourceUrl,
        license: 'CC BY 4.0',
        attribution: 'Example Author',
      }),
    ).resolves.toMatchObject({
      kind: 'licensed',
      sourceUrl: licensedSourceUrl,
      license: 'CC BY 4.0',
      attribution: 'Example Author',
    });
    const [licensed] = await connection.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.sourceUrl, licensedSourceUrl));
    expect(licensed).toMatchObject({
      workspaceId: ids.workspace,
      createdByUserId: ids.user,
      kind: 'licensed',
    });
  });
});
