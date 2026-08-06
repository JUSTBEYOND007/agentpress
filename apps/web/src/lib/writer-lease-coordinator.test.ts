import { describe, expect, it, vi } from 'vitest';

import {
  requiresWriterLeaseForAgentSend,
  WriterLeaseCoordinator,
} from './writer-lease-coordinator';

describe('WriterLeaseCoordinator', () => {
  it('fences a late release from an old editor instance with a new token', async () => {
    const calls: string[] = [];
    const request = vi.fn((action: string, leaseId: string) => {
      calls.push(`${action}:${leaseId}`);
      return Promise.resolve(action !== 'release');
    });
    const oldLease = new WriterLeaseCoordinator(request, 'old-token');
    const newLease = new WriterLeaseCoordinator(request, 'new-token');

    await oldLease.start();
    await newLease.start();
    await oldLease.stop();

    expect(newLease.isOwned).toBe(true);
    expect(calls).toEqual(['acquire:old-token', 'acquire:new-token', 'release:old-token']);
  });

  it('reacquires after renewal loss and serializes overlapping maintenance', async () => {
    let renewals = 0;
    const request = vi.fn((action: string) => {
      if (action === 'renew') return Promise.resolve(renewals++ > 0);
      return Promise.resolve(true);
    });
    const lease = new WriterLeaseCoordinator(request, 'token');

    await lease.start();
    await Promise.all([lease.maintain(), lease.maintain()]);

    expect(lease.isOwned).toBe(true);
    expect(request.mock.calls.map(([action]) => action)).toEqual([
      'acquire',
      'renew',
      'acquire',
      'renew',
    ]);
  });

  it('does not become owned when an in-flight acquire finishes after stop', async () => {
    let resolveAcquire!: (value: boolean) => void;
    const request = vi.fn((action: string) => {
      if (action === 'release') return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        resolveAcquire = resolve;
      });
    });
    const lease = new WriterLeaseCoordinator(request, 'token');
    const started = lease.start();
    await Promise.resolve();
    const stopped = lease.stop();
    resolveAcquire(true);

    await expect(started).resolves.toBe(false);
    await expect(stopped).resolves.toBeUndefined();
    expect(lease.isOwned).toBe(false);
    expect(request.mock.calls.map(([action]) => action)).toEqual(['acquire', 'release']);
  });

  it('requires a writer lease only when local draft facts need flushing', () => {
    expect(requiresWriterLeaseForAgentSend(0, 0)).toBe(false);
    expect(requiresWriterLeaseForAgentSend(1, 0)).toBe(true);
    expect(requiresWriterLeaseForAgentSend(0, 4)).toBe(true);
  });
});
