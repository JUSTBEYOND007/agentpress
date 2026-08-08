import {
  agentRuns,
  approvals,
  artifacts,
  artifactVersions,
  checkpoints,
  evidenceRecords,
  editProposals,
  type AgentPressDatabase,
  modelSelections,
  planRevisions,
  queuedFollowups,
  rootRequests,
  runDirectives,
  runEvents,
  runQuestions,
  toolCalls,
} from '@agentpress/database';
import { and, asc, desc, eq, gt } from 'drizzle-orm';

import { AgentRegistryService } from './agent-registry.js';
import type { DurableRunEvent, RunProjection } from './contracts.js';
import { articleOutcomeArtifactPresentation } from './outcome-receipt.js';
import { projectRunExecutionFacts } from './run-execution-facts.js';
import { projectRunParts, type ProposalProjectionStatus } from './run-projection.js';
import { projectRunProgress } from './run-progress.js';

const TERMINAL_RUN_STATES = [
  'cancelled',
  'completed',
  'completed_with_degradation',
  'failed',
] as const;

export class RunProjectionService {
  private readonly registry: AgentRegistryService;

  public constructor(
    private readonly database: AgentPressDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.registry = new AgentRegistryService(database);
  }

  public async listEvents(runId: string, afterSequence = 0): Promise<readonly DurableRunEvent[]> {
    const events = await this.database
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, afterSequence)))
      .orderBy(asc(runEvents.sequence));
    return events.map(toDurableEvent);
  }

  public async get(runId: string): Promise<RunProjection | undefined> {
    const runRows = await this.database
      .select({
        runId: agentRuns.id,
        rootMessageId: rootRequests.messageId,
        status: agentRuns.status,
        mode: agentRuns.mode,
        revisionNumber: planRevisions.revisionNumber,
        createdAt: agentRuns.createdAt,
        completedAt: agentRuns.completedAt,
      })
      .from(agentRuns)
      .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
      .leftJoin(planRevisions, eq(planRevisions.id, agentRuns.activePlanRevisionId))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const run = runRows[0];
    if (!run) return undefined;
    const [
      events,
      artifactVersionRows,
      evidenceRows,
      questionRows,
      approvalRows,
      proposalRows,
      steeringRows,
      followUpRows,
      modelRows,
      checkpointRows,
      agentEntries,
    ] = await Promise.all([
      this.listEvents(runId),
      this.database
        .select({
          id: artifacts.id,
          type: artifacts.type,
          title: artifacts.title,
          version: artifactVersions.version,
          summary: artifactVersions.summary,
          content: artifactVersions.content,
        })
        .from(artifacts)
        .innerJoin(
          artifactVersions,
          and(
            eq(artifactVersions.artifactId, artifacts.id),
            eq(artifactVersions.version, artifacts.currentVersion),
          ),
        )
        .where(eq(artifacts.runId, runId)),
      this.database
        .select({
          id: evidenceRecords.id,
          title: evidenceRecords.title,
          source: evidenceRecords.sourceUri,
          excerpt: evidenceRecords.excerpt,
          sourceRevision: evidenceRecords.sourceRevision,
          metadata: evidenceRecords.metadata,
        })
        .from(evidenceRecords)
        .where(eq(evidenceRecords.runId, runId)),
      this.database
        .select()
        .from(runQuestions)
        .where(and(eq(runQuestions.runId, runId), eq(runQuestions.status, 'pending')))
        .limit(1),
      this.database
        .select({
          id: approvals.id,
          toolCallId: approvals.toolCallId,
          sideEffect: approvals.displayedSideEffect,
          estimatedCost: approvals.estimatedCost,
          expiresAt: approvals.expiresAt,
        })
        .from(approvals)
        .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
        .where(
          and(
            eq(toolCalls.runId, runId),
            eq(toolCalls.status, 'awaiting_approval'),
            eq(approvals.decision, 'pending'),
          ),
        )
        .orderBy(asc(approvals.createdAt)),
      this.database
        .select({
          id: editProposals.id,
          status: editProposals.status,
          expiresAt: editProposals.expiresAt,
        })
        .from(editProposals)
        .where(eq(editProposals.runId, runId)),
      this.database
        .select({
          id: runDirectives.id,
          content: runDirectives.content,
          sequence: runDirectives.sequence,
          createdAt: runDirectives.createdAt,
        })
        .from(runDirectives)
        .where(and(eq(runDirectives.runId, runId), eq(runDirectives.status, 'pending')))
        .orderBy(asc(runDirectives.sequence)),
      this.database
        .select({
          id: queuedFollowups.id,
          content: queuedFollowups.content,
          sequence: queuedFollowups.sequence,
          createdAt: queuedFollowups.createdAt,
        })
        .from(queuedFollowups)
        .where(and(eq(queuedFollowups.runId, runId), eq(queuedFollowups.status, 'pending')))
        .orderBy(asc(queuedFollowups.sequence)),
      this.database
        .select({
          purpose: modelSelections.purpose,
          selectedModel: modelSelections.selectedModel,
          policySnapshot: modelSelections.policySnapshot,
          fallbackUsed: modelSelections.fallbackUsed,
        })
        .from(modelSelections)
        .where(eq(modelSelections.runId, runId))
        .orderBy(asc(modelSelections.createdAt)),
      this.database
        .select({
          sequence: checkpoints.sequence,
          reason: checkpoints.reason,
          createdAt: checkpoints.createdAt,
        })
        .from(checkpoints)
        .where(eq(checkpoints.runId, runId))
        .orderBy(desc(checkpoints.sequence))
        .limit(1),
      this.registry.listForRun(runId),
    ]);
    const artifactRows = artifactVersionRows.map(({ content, ...artifact }) => {
      const presentation = articleOutcomeArtifactPresentation({ type: artifact.type, content });
      return { ...artifact, ...(presentation ? { presentation } : {}) };
    });
    const question = questionRows[0];
    const proposalStatuses = new Map<string, ProposalProjectionStatus>(
      proposalRows.map((proposal) => [
        proposal.id,
        proposal.status === 'pending' && proposal.expiresAt <= this.now()
          ? 'expired'
          : proposal.status,
      ]),
    );
    const pendingInteraction = question
      ? { type: 'ask-user', id: question.id, question: question.prompt, options: question.options }
      : approvalRows.length > 0
        ? { type: 'tool-approval', approvals: approvalRows }
        : undefined;
    const queuedEvent = events.find(({ eventType }) => eventType === 'run.queued');
    const skillSelectionEvent = events.findLast(
      ({ eventType }) => eventType === 'skill.selection.completed',
    );
    const contextManifest = queuedEvent?.payload.contextManifest;
    const model = modelRows[0];
    const executionFacts = projectRunExecutionFacts({
      runId,
      events,
      modelSelections: modelRows,
      createdAt: run.createdAt,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    });
    const latestCheckpoint = checkpointRows[0];
    const progress = projectRunProgress({
      runId,
      mode: run.mode,
      status: run.status,
      events,
      ...(pendingInteraction ? { pendingInteraction } : {}),
      ...(latestCheckpoint ? { recoveryPoint: latestCheckpoint } : {}),
    });
    return {
      runId,
      rootMessageId: run.rootMessageId,
      status: run.status,
      terminal: isTerminalRunStatus(run.status),
      mode: run.mode,
      ...(run.revisionNumber ? { activePlanRevision: run.revisionNumber } : {}),
      parts: [
        ...projectRunParts(events, proposalStatuses).filter(({ type }) => type !== 'usage'),
        ...(progress ? [progress] : []),
        ...(executionFacts ? [executionFacts] : []),
        ...evidenceRows.map((evidence) => {
          const toolCallId =
            typeof evidence.metadata.toolCallId === 'string'
              ? evidence.metadata.toolCallId
              : undefined;
          const sourceEvent = toolCallId
            ? events.find(
                (event) =>
                  event.eventType === 'tool.succeeded' && event.payload.toolCallId === toolCallId,
              )
            : undefined;
          return {
            id: evidence.id,
            runId,
            sequence: sourceEvent?.sequence ?? 0,
            type: 'evidence' as const,
            status: 'evidence.available',
            payload: evidence,
          };
        }),
        ...artifactRows.map((artifact) => {
          const sourceEvent = events.find(
            (event) =>
              event.eventType === 'task.succeeded' &&
              Array.isArray(event.payload.artifacts) &&
              event.payload.artifacts.some(
                (candidate) => artifactIdFromEvent(candidate) === artifact.id,
              ),
          );
          return {
            id: artifact.id,
            runId,
            sequence: sourceEvent?.sequence ?? 0,
            type: 'artifact' as const,
            status: 'artifact.available',
            payload: artifact,
          };
        }),
        ...(run.status === 'failed' &&
        [...proposalStatuses.values()].some(
          (status) => status === 'pending' || status === 'partially_accepted',
        )
          ? [
              {
                id: `${runId}:pending-draft-preserved`,
                runId,
                sequence: events.at(-1)?.sequence ?? 0,
                type: 'warning' as const,
                status: 'run.failed',
                payload: { pendingDraft: true },
              },
            ]
          : []),
      ],
      artifacts: artifactRows,
      agents: agentEntries.map((entry) => ({
        ...entry,
        updatedAt: entry.updatedAt.toISOString(),
      })),
      ...(contextManifest && typeof contextManifest === 'object'
        ? {
            context: {
              manifest: contextManifest,
              contextHash: queuedEvent.payload.contextHash,
              ...(skillSelectionEvent ? { skillSelections: skillSelectionEvent.payload } : {}),
              ...(model
                ? {
                    model: model.selectedModel,
                    provider: model.policySnapshot.provider,
                    contextWindow: model.policySnapshot.contextWindow,
                    maxOutputTokens: model.policySnapshot.maxOutputTokens,
                    fallbackUsed: model.fallbackUsed,
                  }
                : {}),
            },
          }
        : {}),
      ...(pendingInteraction ? { pendingInteraction } : {}),
      pendingDirectives: [
        ...steeringRows.map((directive) => ({
          ...directive,
          kind: 'steering' as const,
          createdAt: directive.createdAt.toISOString(),
        })),
        ...followUpRows.map((directive) => ({
          ...directive,
          kind: 'follow_up' as const,
          createdAt: directive.createdAt.toISOString(),
        })),
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      lastEventId: events.at(-1)?.sequence ?? 0,
      createdAt: run.createdAt.toISOString(),
      ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    };
  }
}

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(status);
}

function artifactIdFromEvent(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  return typeof artifact.artifactId === 'string' ? artifact.artifactId : undefined;
}

export function toDurableEvent(event: typeof runEvents.$inferSelect): DurableRunEvent {
  return {
    id: event.id,
    runId: event.runId,
    sequence: event.sequence,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}
