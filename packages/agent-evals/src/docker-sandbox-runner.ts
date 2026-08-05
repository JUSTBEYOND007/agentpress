import { spawn } from 'node:child_process';

import type { DockerEvalSandboxPlan } from './docker-sandbox-plan.js';

export type DockerEvalSandboxFailureReason =
  | 'aborted'
  | 'exit_nonzero'
  | 'output_limit'
  | 'timeout';

export type DockerEvalSandboxResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export class DockerEvalSandboxExecutionError extends Error {
  public constructor(
    public readonly reason: DockerEvalSandboxFailureReason,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(`Docker evaluation sandbox failed: ${reason}`);
    this.name = 'DockerEvalSandboxExecutionError';
  }
}

/** Executes an immutable sandbox plan without a shell and force-cleans interrupted containers. */
export async function executeDockerEvalSandbox(
  plan: DockerEvalSandboxPlan,
  options: {
    readonly signal?: AbortSignal;
    readonly maxOutputBytes?: number;
  } = {},
): Promise<DockerEvalSandboxResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 16 * 1024 * 1024
  ) {
    throw new RangeError('Docker evaluation sandbox output limit is invalid');
  }
  if (options.signal?.aborted) {
    throw new DockerEvalSandboxExecutionError('aborted', '', '', null);
  }

  const child = spawn(plan.executable, [...plan.arguments], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let failureReason: DockerEvalSandboxFailureReason | undefined;
  let cleanup: Promise<void> | undefined;

  const terminate = (reason: DockerEvalSandboxFailureReason): void => {
    if (failureReason) return;
    failureReason = reason;
    child.kill('SIGTERM');
    cleanup = forceRemoveContainer(plan.containerName);
  };
  const append = (target: 'stdout' | 'stderr', chunk: string): void => {
    if (failureReason === 'output_limit') return;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maxOutputBytes) {
      terminate('output_limit');
      return;
    }
    if (target === 'stdout') stdout += chunk;
    else stderr += chunk;
  };
  child.stdout.on('data', (chunk: string) => {
    append('stdout', chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    append('stderr', chunk);
  });

  const onAbort = (): void => {
    terminate('aborted');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    terminate('timeout');
  }, plan.timeoutMs);
  timeout.unref();

  try {
    const outcome = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
    });
    await cleanup;
    if (failureReason) {
      await forceRemoveContainer(plan.containerName);
      throw new DockerEvalSandboxExecutionError(failureReason, stdout, stderr, outcome.code);
    }
    if (outcome.code !== 0) {
      throw new DockerEvalSandboxExecutionError('exit_nonzero', stdout, stderr, outcome.code);
    }
    return { exitCode: outcome.code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function forceRemoveContainer(containerName: string): Promise<void> {
  const child = spawn('docker', ['rm', '--force', containerName], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
  }, 10_000);
  timeout.unref();
  try {
    await new Promise<void>((resolve) => {
      child.once('error', () => {
        resolve();
      });
      child.once('close', () => {
        resolve();
      });
    });
  } finally {
    clearTimeout(timeout);
  }
}
