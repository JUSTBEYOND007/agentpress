import { describe, expect, it } from 'vitest';

import { runWithKafkaHeartbeat } from '../src/kafka-heartbeat.js';

describe('runWithKafkaHeartbeat', () => {
  it('keeps a long operation in the consumer group and stops after settlement', async () => {
    let heartbeats = 0;
    await runWithKafkaHeartbeat(
      () => new Promise<void>((resolve) => setTimeout(resolve, 35)),
      () => {
        heartbeats += 1;
        return Promise.resolve();
      },
      { intervalMs: 5 },
    );

    expect(heartbeats).toBeGreaterThanOrEqual(3);
    const settledCount = heartbeats;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(heartbeats).toBe(settledCount);
  });

  it('does not replace the operation result when a heartbeat fails', async () => {
    const errors: unknown[] = [];
    const result = await runWithKafkaHeartbeat(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            resolve('completed');
          }, 20),
        ),
      () => Promise.reject(new Error('rebalance')),
      {
        intervalMs: 5,
        onHeartbeatError: (error) => {
          errors.push(error);
        },
      },
    );

    expect(result).toBe('completed');
    expect(errors.length).toBeGreaterThan(0);
  });
});
