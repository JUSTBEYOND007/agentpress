import type { Admin } from 'kafkajs';

export const AGENT_RUN_PARTITIONS = 12;
export const ARTICLE_INDEX_PARTITIONS = 4;

export type KafkaTopicSpec = {
  readonly topic: string;
  readonly partitions: number;
};

export async function ensureKafkaTopics(
  admin: Admin,
  specs: readonly KafkaTopicSpec[],
): Promise<void> {
  const existing = new Set(await admin.listTopics());
  const missing = specs.filter(({ topic }) => !existing.has(topic));
  if (missing.length > 0) {
    await admin.createTopics({
      topics: missing.map(({ topic, partitions }) => ({ topic, numPartitions: partitions })),
      waitForLeaders: true,
    });
  }

  const present = specs.filter(({ topic }) => existing.has(topic));
  if (present.length === 0) return;
  const metadata = await admin.fetchTopicMetadata({ topics: present.map(({ topic }) => topic) });
  const partitionCounts = new Map(
    metadata.topics.map(({ name, partitions }) => [name, partitions.length] as const),
  );
  const expansions = present.filter(
    ({ topic, partitions }) => (partitionCounts.get(topic) ?? 0) < partitions,
  );
  if (expansions.length === 0) return;
  await admin.createPartitions({
    topicPartitions: expansions.map(({ topic, partitions }) => ({ topic, count: partitions })),
  });
}
