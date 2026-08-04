import { agentRuns, runDirectives, runToolChoices, type PersistedToolChoice } from './schema.js';
import type { AgentPressDatabase } from './postgres.js';
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';

export type ToolChoiceSettlement = 'resolved' | 'rejected' | 'cancelled';

export class ToolChoiceQueueStore {
  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly createId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async enqueue(input: {
    readonly runId: string;
    readonly choice: PersistedToolChoice;
    readonly label: string;
  }): Promise<{ readonly id: string; readonly sequence: number }> {
    const label = input.label.trim();
    if (!label || label.length > 160) throw new TypeError('Tool choice label is invalid');
    if (
      typeof input.choice === 'object' &&
      (!input.choice.name.trim() || input.choice.name.length > 128)
    ) {
      throw new TypeError('Named tool choice is invalid');
    }
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${agentRuns} where id = ${input.runId} for update`,
      );
      const rows = await transaction
        .select({ sequence: max(runToolChoices.sequence) })
        .from(runToolChoices)
        .where(eq(runToolChoices.runId, input.runId));
      const sequence = (rows[0]?.sequence ?? 0) + 1;
      const id = this.createId();
      await transaction.insert(runToolChoices).values({
        id,
        runId: input.runId,
        sequence,
        choice: input.choice,
        label,
      });
      return { id, sequence };
    });
  }

  public async claimNext(input: {
    readonly runId: string;
    readonly claimToken: string;
  }): Promise<
    | { readonly id: string; readonly choice: PersistedToolChoice; readonly label: string }
    | undefined
  > {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${agentRuns} where id = ${input.runId} for update`,
      );
      const steering = await transaction
        .select({ id: runDirectives.id })
        .from(runDirectives)
        .where(
          and(
            eq(runDirectives.runId, input.runId),
            eq(runDirectives.kind, 'steering'),
            eq(runDirectives.status, 'pending'),
          ),
        )
        .limit(1);
      if (steering.length > 0) return undefined;
      const active = await transaction
        .select({ id: runToolChoices.id })
        .from(runToolChoices)
        .where(and(eq(runToolChoices.runId, input.runId), eq(runToolChoices.status, 'in_flight')))
        .limit(1);
      if (active.length > 0) return undefined;
      const rows = await transaction
        .select({
          id: runToolChoices.id,
          choice: runToolChoices.choice,
          label: runToolChoices.label,
        })
        .from(runToolChoices)
        .where(and(eq(runToolChoices.runId, input.runId), eq(runToolChoices.status, 'pending')))
        .orderBy(asc(runToolChoices.sequence))
        .for('update')
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      const claimed = await transaction
        .update(runToolChoices)
        .set({ status: 'in_flight', claimToken: input.claimToken, claimedAt: this.now() })
        .where(and(eq(runToolChoices.id, row.id), eq(runToolChoices.status, 'pending')))
        .returning({ id: runToolChoices.id });
      return claimed.length === 1 ? row : undefined;
    });
  }

  public async settle(input: {
    readonly id: string;
    readonly claimToken: string;
    readonly status: ToolChoiceSettlement;
    readonly reason?: string;
  }): Promise<boolean> {
    const rows = await this.database
      .update(runToolChoices)
      .set({
        status: input.status,
        settledAt: this.now(),
        ...(input.reason ? { rejectionReason: input.reason } : {}),
      })
      .where(
        and(
          eq(runToolChoices.id, input.id),
          eq(runToolChoices.claimToken, input.claimToken),
          eq(runToolChoices.status, 'in_flight'),
        ),
      )
      .returning({ id: runToolChoices.id });
    return rows.length === 1;
  }

  public async cancelRun(runId: string): Promise<number> {
    const rows = await this.database
      .update(runToolChoices)
      .set({ status: 'cancelled', settledAt: this.now(), rejectionReason: 'cancelled' })
      .where(
        and(
          eq(runToolChoices.runId, runId),
          inArray(runToolChoices.status, ['pending', 'in_flight']),
        ),
      )
      .returning({ id: runToolChoices.id });
    return rows.length;
  }

  public async requeueInFlight(runId: string): Promise<number> {
    const rows = await this.database
      .update(runToolChoices)
      .set({
        status: 'pending',
        claimToken: null,
        claimedAt: null,
        rejectionReason: null,
        recoveryCount: sql`${runToolChoices.recoveryCount} + 1`,
      })
      .where(and(eq(runToolChoices.runId, runId), eq(runToolChoices.status, 'in_flight')))
      .returning({ id: runToolChoices.id });
    return rows.length;
  }
}
