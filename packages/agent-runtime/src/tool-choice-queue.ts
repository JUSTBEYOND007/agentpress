// Behavior adapted from Oh My Pi v17.1.8, commit f446b8a (MIT).
// Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Boluk.
import type { RuntimeToolChoice } from './contracts.js';

export type ToolChoiceRejectReason =
  | 'aborted'
  | 'error'
  | 'cleared'
  | 'unavailable'
  | 'not_invoked';
export type ToolChoiceRejectOutcome = 'requeue' | 'drop' | 'drop_sequence';

export type ToolChoiceDirective = {
  readonly choices: readonly RuntimeToolChoice[];
  readonly label: string;
  readonly onRejected?: (input: {
    readonly choice: RuntimeToolChoice;
    readonly reason: ToolChoiceRejectReason;
  }) => ToolChoiceRejectOutcome | undefined;
};

type InFlightChoice = {
  readonly directive: ToolChoiceDirective;
  readonly choice: RuntimeToolChoice;
  readonly index: number;
};

/**
 * Host-owned, one-yield-at-a-time forced tool choice queue.
 *
 * Steering is an immediate user correction and therefore suppresses a forced
 * choice for that turn; follow-ups are deferred until the active run ends and
 * do not suppress the current forced choice. Persistence is intentionally
 * outside this pure state machine; callers must persist the directive before
 * enqueueing it and settle it after resolve/reject.
 */
export class ToolChoiceQueue {
  private readonly pending: ToolChoiceDirective[] = [];
  private inFlight: InFlightChoice | undefined;

  public pushOnce(
    choice: RuntimeToolChoice,
    label: string,
    onRejected?: ToolChoiceDirective['onRejected'],
  ): void {
    this.pushSequence([choice], label, onRejected);
  }

  public pushSequence(
    choices: readonly RuntimeToolChoice[],
    label: string,
    onRejected?: ToolChoiceDirective['onRejected'],
  ): void {
    if (choices.length === 0 || !label.trim())
      throw new TypeError('Tool choice directive is empty');
    this.pending.push({ choices: [...choices], label, ...(onRejected ? { onRejected } : {}) });
  }

  public next(availability: {
    readonly steeringPending: boolean;
    readonly followUpPending: boolean;
  }): RuntimeToolChoice | undefined {
    if (availability.steeringPending || this.inFlight || this.pending.length === 0)
      return undefined;
    // Follow-ups deliberately do not block the active run; they are consumed
    // by the next run after the current one settles.
    void availability.followUpPending;
    const directive = this.pending[0];
    const index = 0;
    const choice = directive?.choices[index];
    if (!directive || choice === undefined) return undefined;
    this.inFlight = { directive, choice, index };
    return choice;
  }

  public resolve(): void {
    const inFlight = this.inFlight;
    if (!inFlight) return;
    this.inFlight = undefined;
    const head = this.pending[0];
    if (!head || head !== inFlight.directive) return;
    if (inFlight.index + 1 >= head.choices.length) this.pending.shift();
    else this.pending[0] = { ...head, choices: head.choices.slice(inFlight.index + 1) };
  }

  public reject(reason: ToolChoiceRejectReason): void {
    const inFlight = this.inFlight;
    if (!inFlight) return;
    this.inFlight = undefined;
    const head = this.pending[0];
    if (!head || head !== inFlight.directive) return;
    const outcome = head.onRejected?.({ choice: inFlight.choice, reason }) ?? 'drop';
    if (outcome === 'requeue') {
      this.pending[0] = {
        ...head,
        choices: [inFlight.choice, ...head.choices.slice(inFlight.index + 1)],
      };
    } else if (outcome === 'drop_sequence') {
      this.pending.shift();
    } else if (inFlight.index + 1 >= head.choices.length) {
      this.pending.shift();
    } else {
      this.pending[0] = { ...head, choices: head.choices.slice(inFlight.index + 1) };
    }
  }

  public clear(): void {
    if (this.inFlight) this.reject('cleared');
    this.pending.length = 0;
  }

  public get hasInFlight(): boolean {
    return this.inFlight !== undefined;
  }

  public inspect(): readonly string[] {
    return this.pending.map(({ label }) => label);
  }
}
