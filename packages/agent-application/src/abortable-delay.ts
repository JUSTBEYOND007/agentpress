export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError(signal.reason));
      },
      { once: true },
    );
  });
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Operation aborted', { cause: reason });
}
