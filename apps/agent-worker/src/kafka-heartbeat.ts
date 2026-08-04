export type KafkaHeartbeat = () => Promise<void>;

export async function runWithKafkaHeartbeat<T>(
  operation: () => Promise<T>,
  heartbeat: KafkaHeartbeat,
  options: {
    readonly intervalMs?: number;
    readonly onHeartbeatError?: (error: unknown) => void;
  } = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 3_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pendingHeartbeat = Promise.resolve();

  const schedule = (): void => {
    timer = setTimeout(() => {
      pendingHeartbeat = pendingHeartbeat
        .then(heartbeat)
        .catch((error: unknown) => options.onHeartbeatError?.(error))
        .finally(() => {
          if (!stopped) schedule();
        });
    }, intervalMs);
  };

  schedule();
  try {
    return await operation();
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pendingHeartbeat;
  }
}
