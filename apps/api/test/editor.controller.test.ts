import type {
  AutosaveService,
  ProposalService,
  RedisWriterLease,
} from '@agentpress/editor-application';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EditorController } from '../src/editor/editor.controller.js';

describe('EditorController', () => {
  it('passes a complete AutosaveBatch to the service', async () => {
    const save = vi.fn((input: unknown) => Promise.resolve(input));
    const controller = new EditorController(
      { save } as AutosaveService,
      {} as ProposalService,
      {} as RedisWriterLease,
    );
    await controller.save('article', {
      updateId: 'update',
      userId: 'user',
      writerLeaseId: 'lease',
      baseRevisionId: 'revision',
      schemaVersion: 1,
      steps: [{ stepType: 'replace' }],
    });
    expect(save).toHaveBeenCalledWith({
      articleId: 'article',
      updateId: 'update',
      userId: 'user',
      writerLeaseId: 'lease',
      baseRevisionId: 'revision',
      schemaVersion: 1,
      steps: [{ stepType: 'replace' }],
    });
  });
  it('rejects invalid proposal decisions before persistence', async () => {
    const controller = new EditorController(
      {} as AutosaveService,
      {} as ProposalService,
      {} as RedisWriterLease,
    );
    await expect(
      controller.decide('proposal', { userId: 'user', decisions: { op: 'maybe' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
