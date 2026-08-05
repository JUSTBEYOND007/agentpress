import type { AgentPressDatabase } from '@agentpress/database';
import type { Admin } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';

import {
  createEvalSandboxDescriptor,
  EvalSandboxResourceManager,
  type EvalSandboxObjectPrefixStore,
} from '../src/index.js';

describe('evaluation sandbox resource manager', () => {
  it('provisions all trial resources and cleans them exactly once', async () => {
    const execute = vi.fn(() => Promise.resolve());
    const createTopics = vi.fn(() => Promise.resolve(true));
    const deleteTopics = vi.fn(() => Promise.resolve());
    const reserve = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    const manager = new EvalSandboxResourceManager(
      { execute } as unknown as AgentPressDatabase,
      { createTopics, deleteTopics } as unknown as Admin,
      { reserve, clear },
    );
    const descriptor = createEvalSandboxDescriptor({
      experimentId: 'experiment',
      armId: 'arm',
      trialId: 'trial',
    });

    const lease = await manager.provision(descriptor);
    await Promise.all([lease.cleanup(), lease.cleanup()]);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(createTopics).toHaveBeenCalledWith({
      topics: [{ topic: descriptor.kafkaTopic, numPartitions: 1 }],
      waitForLeaders: true,
    });
    expect(deleteTopics).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(descriptor.objectPrefix);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('does not delete a pre-existing Kafka topic or object prefix when provisioning fails closed', async () => {
    const execute = vi.fn(() => Promise.resolve());
    const deleteTopics = vi.fn(() => Promise.resolve());
    const reserve = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    const objects: EvalSandboxObjectPrefixStore = {
      reserve,
      clear,
    };
    const manager = new EvalSandboxResourceManager(
      { execute } as unknown as AgentPressDatabase,
      {
        createTopics: () => Promise.resolve(false),
        deleteTopics,
      } as unknown as Admin,
      objects,
    );

    await expect(
      manager.provision(
        createEvalSandboxDescriptor({
          experimentId: 'experiment',
          armId: 'arm',
          trialId: 'contaminated-trial',
        }),
      ),
    ).rejects.toThrow(/Kafka topic is already in use/u);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(deleteTopics).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});
