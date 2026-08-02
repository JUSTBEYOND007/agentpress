import type { Admin } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';

import { ensureKafkaTopics } from '../src/kafka-topics.js';

describe('ensureKafkaTopics', () => {
  it('creates missing topics at their required partition counts', async () => {
    const admin = {
      listTopics: vi.fn(() => Promise.resolve<string[]>([])),
      createTopics: vi.fn(() => Promise.resolve(true)),
      fetchTopicMetadata: vi.fn(),
      createPartitions: vi.fn(),
    } as unknown as Admin;

    await ensureKafkaTopics(admin, [{ topic: 'agent.run.commands', partitions: 12 }]);

    expect(admin.createTopics).toHaveBeenCalledWith({
      topics: [{ topic: 'agent.run.commands', numPartitions: 12 }],
      waitForLeaders: true,
    });
    expect(admin.fetchTopicMetadata).not.toHaveBeenCalled();
  });

  it('expands existing topics without recreating them', async () => {
    const admin = {
      listTopics: vi.fn(() => Promise.resolve(['agent.run.commands'])),
      createTopics: vi.fn(),
      fetchTopicMetadata: vi.fn(() =>
        Promise.resolve({
          topics: [{ name: 'agent.run.commands', partitions: [{ partitionId: 0 }] }],
        }),
      ),
      createPartitions: vi.fn(() => Promise.resolve(true)),
    } as unknown as Admin;

    await ensureKafkaTopics(admin, [{ topic: 'agent.run.commands', partitions: 12 }]);

    expect(admin.createTopics).not.toHaveBeenCalled();
    expect(admin.createPartitions).toHaveBeenCalledWith({
      topicPartitions: [{ topic: 'agent.run.commands', count: 12 }],
    });
  });
});
