export type WriterLeaseAction = 'acquire' | 'renew' | 'release';
export type WriterLeaseState = 'connecting' | 'owned' | 'lost' | 'stopped';

export type WriterLeaseRequest = (action: WriterLeaseAction, leaseId: string) => Promise<boolean>;

export class WriterLeaseCoordinator {
  private active = false;
  private owned = false;
  private operation: Promise<unknown> = Promise.resolve();
  private state: WriterLeaseState = 'stopped';

  public constructor(
    private readonly request: WriterLeaseRequest,
    private readonly leaseId: string,
    private readonly onStateChange?: (state: WriterLeaseState) => void,
  ) {}

  public get id(): string {
    return this.leaseId;
  }

  public get isOwned(): boolean {
    return this.owned;
  }

  public start(): Promise<boolean> {
    this.active = true;
    this.setState('connecting');
    return this.enqueue(() => this.acquire());
  }

  public ensureOwned(): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    if (this.owned) return Promise.resolve(true);
    this.setState('connecting');
    return this.enqueue(() => this.acquire());
  }

  public maintain(): Promise<boolean> {
    if (!this.isActive()) return Promise.resolve(false);
    return this.enqueue(async () => {
      if (!this.isActive()) return false;
      if (this.owned) {
        const renewed = await this.request('renew', this.leaseId);
        if (!this.isActive()) return false;
        if (renewed) {
          this.setState('owned');
          return true;
        }
        this.owned = false;
        this.setState('lost');
      }
      return this.acquire();
    });
  }

  public markLost(): void {
    if (!this.active) return;
    this.owned = false;
    this.setState('lost');
  }

  public stop(): Promise<void> {
    this.active = false;
    this.owned = false;
    this.setState('stopped');
    return this.enqueue(async () => {
      await this.request('release', this.leaseId);
    }).then(
      () => undefined,
      () => undefined,
    );
  }

  private acquire(): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    return this.request('acquire', this.leaseId).then((acquired) => {
      if (!acquired) {
        this.owned = false;
        this.setState('lost');
        return false;
      }
      if (!this.active) {
        return false;
      }
      this.owned = true;
      this.setState('owned');
      return true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private setState(state: WriterLeaseState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private isActive(): boolean {
    return this.active;
  }
}

export function createWriterLeaseId(): string {
  return crypto.randomUUID();
}

export function requiresWriterLeaseForAgentSend(
  pendingAutosaveCount: number,
  latestServerSequence: number,
): boolean {
  return pendingAutosaveCount > 0 || latestServerSequence > 0;
}
