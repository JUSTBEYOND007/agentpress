import type { Admin } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';

import { ensureKafkaTopics } from '../src/kafka-topics.js';

describe('ensureKafkaTopics', () => {
  it('creates missing topics at their required partition counts', async () => {
    const createTopics = vi.fn(() => Promise.resolve(true));
    const fetchTopicMetadata = vi.fn();
    const admin = {
      listTopics: vi.fn(() => Promise.resolve<string[]>([])),
      createTopics,
      fetchTopicMetadata,
      createPartitions: vi.fn(),
    } as unknown as Admin;

    await ensureKafkaTopics(admin, [{ topic: 'agent.run.commands', partitions: 12 }]);

    expect(createTopics).toHaveBeenCalledWith({
      topics: [{ topic: 'agent.run.commands', numPartitions: 12 }],
      waitForLeaders: true,
    });
    expect(fetchTopicMetadata).not.toHaveBeenCalled();
  });

  it('expands existing topics without recreating them', async () => {
    const createTopics = vi.fn();
    const createPartitions = vi.fn(() => Promise.resolve(true));
    const admin = {
      listTopics: vi.fn(() => Promise.resolve(['agent.run.commands'])),
      createTopics,
      fetchTopicMetadata: vi.fn(() =>
        Promise.resolve({
          topics: [{ name: 'agent.run.commands', partitions: [{ partitionId: 0 }] }],
        }),
      ),
      createPartitions,
    } as unknown as Admin;

    await ensureKafkaTopics(admin, [{ topic: 'agent.run.commands', partitions: 12 }]);

    expect(createTopics).not.toHaveBeenCalled();
    expect(createPartitions).toHaveBeenCalledWith({
      topicPartitions: [{ topic: 'agent.run.commands', count: 12 }],
    });
  });
});
