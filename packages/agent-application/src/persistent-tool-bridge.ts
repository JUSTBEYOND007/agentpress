import { createHash } from 'node:crypto';

import type { RuntimeTool, RuntimeToolResultMessage } from '@agentpress/agent-runtime';
import { parseActionEnvelope } from '@agentpress/contracts';
import {
  agentRuns,
  conversationBranches,
  conversations,
  type AgentPressDatabase,
  rootRequests,
  runSkillBindings,
  skillRevisions,
  toolCalls,
  workspaceMembers,
} from '@agentpress/database';
import { composeToolGuidance, hashToolArguments, ToolRegistry } from '@agentpress/tool-runtime';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { RuntimeToolFactory } from './contracts.js';
import { effectiveActionCapabilities } from './action-capability-policy.js';
import { ToolCallApplicationError, ToolCallService } from './tool-call-service.js';
import { ToolEvidenceStore } from './tool-evidence-store.js';

type PersistentToolBridgeOptions = {
  readonly database: AgentPressDatabase;
  readonly registry: ToolRegistry;
  readonly toolCalls: ToolCallService;
  readonly capabilityLimit?: number;
};

const ARTICLE_CONTEXT_CAPABILITIES = new Set(['article.read', 'article.propose']);

export class PersistentToolBridge implements RuntimeToolFactory {
  private readonly evidence: ToolEvidenceStore;

  public constructor(private readonly options: PersistentToolBridgeOptions) {
    this.evidence = new ToolEvidenceStore({ database: options.database });
  }

  public async listCapabilities(runId: string): Promise<readonly string[]> {
    const { definitions } = await this.authorize(runId);
    return [...new Set(definitions.flatMap(({ capabilities }) => capabilities))].sort();
  }

  public async createForRun(
    runId: string,
    capabilities: readonly string[] = [],
    taskId?: string,
    taskAttempt?: number,
  ): Promise<readonly RuntimeTool[]> {
    if ((taskId === undefined) !== (taskAttempt === undefined)) {
      throw new TypeError('Specialist tools require both taskId and taskAttempt');
    }
    if (taskAttempt !== undefined && (!Number.isSafeInteger(taskAttempt) || taskAttempt < 1)) {
      throw new RangeError('Specialist tool attempt must be a positive integer');
    }
    const { definitions, requestedByUserId, allowedCapabilities } = await this.authorize(runId);
    const requested = new Set(capabilities);
    const taskOperationState = taskId
      ? await loadTaskOperationState(this.options.database, taskId)
      : undefined;
    return definitions
      .filter((definition) =>
        definition.capabilities.every((capability) => requested.has(capability)),
      )
      .slice(0, this.options.capabilityLimit ?? 16)
      .map((definition) => ({
        name: runtimeToolName(definition.toolId, definition.version),
        label: definition.toolId,
        description: appendToolGuidance(definition),
        parameters: definition.inputSchema,
        constrainedSampling: { type: 'json_schema' as const, strict: 'prefer' as const },
        executionMode: definition.risk === 'read_only' ? 'parallel' : 'sequential',
        execute: async (arguments_, context) => {
          const taskOperation =
            taskId && taskAttempt && definition.risk !== 'read_only'
              ? resolveTaskOperation(
                  taskId,
                  definition.toolId,
                  definition.version,
                  arguments_,
                  context.providerToolCallId,
                  taskOperationState,
                )
              : undefined;
          const proposal = await this.options.toolCalls.propose({
            runId,
            ...(taskId && taskAttempt ? { taskId, taskAttempt } : {}),
            providerToolCallId: context.providerToolCallId,
            toolId: definition.toolId,
            toolVersion: definition.version,
            arguments: arguments_,
            requestedFromUserId: requestedByUserId,
            allowedCapabilities,
            idempotencyKey:
              taskOperation?.key ?? toolIdempotencyKey(runId, context.providerToolCallId),
            ...(taskOperation
              ? {
                  taskOperationKey: taskOperation.key,
                  taskOperationOrdinal: taskOperation.ordinal,
                }
              : {}),
          });
          if (proposal.status === 'blocked') {
            if (
              taskOperation &&
              (proposal.blockedStatus === 'executing' ||
                proposal.blockedStatus === 'outcome_unknown')
            ) {
              taskOperationState?.blockedOrdinal.set(
                taskOperation.signature,
                taskOperation.ordinal,
              );
            }
            throw new ToolCallApplicationError(
              'tool_replay_blocked',
              `Tool Call ${proposal.toolCallId} cannot be replayed from ${proposal.blockedStatus ?? 'an unknown state'}`,
            );
          }
          if (proposal.status === 'awaiting_approval') {
            const decision = await this.options.toolCalls.waitUntilExecutable(
              proposal.toolCallId,
              context.signal,
            );
            if (decision !== 'approved') {
              throw new ToolCallApplicationError(
                decision === 'denied' ? 'approval_denied' : 'approval_expired',
                `Tool Call ${proposal.toolCallId} was ${decision}`,
              );
            }
          }
          const result = await this.options.toolCalls.execute(proposal.toolCallId, context.signal);
          if (result.status !== 'succeeded') {
            throw new ToolCallApplicationError(
              result.status === 'outcome_unknown' ? 'tool_replay_blocked' : 'invalid_tool_state',
              `Tool Call ${proposal.toolCallId} settled as ${result.status}`,
            );
          }
          const evidence = await this.evidence.listForToolCall(proposal.toolCallId);
          if (evidence.length === 0) return result.output;
          return {
            output: result.output,
            evidence,
          };
        },
      }));
  }

  public async resumeApprovedToolCall(
    runId: string,
    taskId: string,
    providerToolCallId: string,
  ): Promise<RuntimeToolResultMessage | undefined> {
    const rows = await this.options.database
      .select()
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.runId, runId),
          eq(toolCalls.taskId, taskId),
          eq(toolCalls.providerToolCallId, providerToolCallId),
          inArray(toolCalls.status, ['proposed', 'approved', 'succeeded', 'denied', 'expired']),
        ),
      )
      .orderBy(desc(toolCalls.createdAt))
      .limit(1);
    const call = rows[0];
    if (!call?.providerToolCallId) return undefined;
    const toolName = runtimeToolName(call.toolId, call.toolVersion);
    if (call.status === 'denied' || call.status === 'expired') {
      return {
        role: 'tool',
        toolCallId: call.providerToolCallId,
        toolName,
        content: `Tool call ${call.status}`,
        details: { toolCallId: call.id, status: call.status },
        isError: true,
        timestamp: call.updatedAt.getTime(),
      };
    }
    const result = await this.options.toolCalls.execute(call.id);
    return {
      role: 'tool',
      toolCallId: call.providerToolCallId,
      toolName,
      content: serializeToolResult(result.output),
      details: result.output,
      isError: result.status !== 'succeeded',
      timestamp: Date.now(),
    };
  }

  private async authorize(runId: string) {
    const rows = await this.options.database
      .select({
        userId: rootRequests.requestedByUserId,
        role: workspaceMembers.role,
        articleId: conversations.articleId,
        actionEnvelope: rootRequests.actionEnvelope,
      })
      .from(agentRuns)
      .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
      .innerJoin(conversationBranches, eq(conversationBranches.id, agentRuns.branchId))
      .innerJoin(conversations, eq(conversations.id, conversationBranches.conversationId))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, agentRuns.workspaceId),
          eq(workspaceMembers.userId, rootRequests.requestedByUserId),
        ),
      )
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const authorization = rows[0];
    if (!authorization?.userId || !authorization.role) {
      throw new ToolCallApplicationError(
        'unauthorized_tool',
        'Agent Run has no active requesting workspace member',
      );
    }
    const skillRows = await this.options.database
      .select({
        allowedTools: runSkillBindings.allowedTools,
        bindingHash: runSkillBindings.contentHash,
        revisionHash: skillRevisions.contentHash,
      })
      .from(runSkillBindings)
      .innerJoin(skillRevisions, eq(skillRevisions.id, runSkillBindings.skillRevisionId))
      .where(eq(runSkillBindings.runId, runId));
    if (skillRows.some(({ bindingHash, revisionHash }) => bindingHash !== revisionHash)) {
      throw new ToolCallApplicationError(
        'unauthorized_tool',
        'Agent Run Skill binding does not match its pinned revision',
      );
    }
    const policyDefinitions = this.options.registry
      .list()
      .filter((definition) => authorization.role !== 'viewer' || definition.risk === 'read_only')
      .filter(
        (definition) =>
          authorization.articleId !== null ||
          definition.capabilities.every(
            (capability) => !ARTICLE_CONTEXT_CAPABILITIES.has(capability),
          ),
      )
      .filter(
        (definition) =>
          skillRows.length === 0 ||
          skillRows.every(({ allowedTools }) => allowedTools.includes(definition.toolId)),
      );
    const actionEnvelope = parseActionEnvelope(authorization.actionEnvelope);
    const effectiveCapabilities = effectiveActionCapabilities(
      actionEnvelope,
      policyDefinitions.flatMap(({ capabilities }) => capabilities),
      {
        allowArticleDraftWrite: authorization.articleId !== null && authorization.role !== 'viewer',
      },
    );
    const definitions = policyDefinitions.filter((definition) =>
      definition.capabilities.every((capability) => effectiveCapabilities.has(capability)),
    );
    return {
      definitions,
      requestedByUserId: authorization.userId,
      allowedCapabilities: effectiveCapabilities,
    };
  }
}

function appendToolGuidance(definition: ReturnType<ToolRegistry['list']>[number]): string {
  const guidance = composeToolGuidance([
    {
      toolId: definition.toolId,
      version: definition.version,
      description: definition.description,
      guidance: definition.guidance ?? [],
      capabilities: definition.capabilities,
      risk: definition.risk,
    },
  ]);
  return guidance ? `${definition.description}\n\n${guidance}` : definition.description;
}

function serializeToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

export function runtimeToolName(toolId: string, version: string): string {
  const base = `${toolId}_${version}`
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const suffix = createHash('sha256').update(`${toolId}@${version}`).digest('hex').slice(0, 10);
  return `${base || 'tool'}_${suffix}`;
}

function toolIdempotencyKey(runId: string, providerToolCallId: string): string {
  return `pi:${createHash('sha256').update(`${runId}:${providerToolCallId}`).digest('hex')}`;
}

function resolveTaskOperation(
  taskId: string,
  toolId: string,
  toolVersion: string,
  arguments_: Readonly<Record<string, unknown>>,
  providerToolCallId: string,
  state: TaskOperationState | undefined,
): { readonly key: string; readonly ordinal: number; readonly signature: string } {
  if (!state) throw new TypeError('Specialist task operation state is unavailable');
  const argumentsHash = hashToolArguments(arguments_);
  const signature = taskOperationSignature(toolId, toolVersion, argumentsHash);
  let ordinal = state.providerOrdinal.get(providerToolCallId);
  if (ordinal === undefined) {
    ordinal =
      state.blockedOrdinal.get(signature) ??
      state.pendingOrdinal.get(signature) ??
      (state.nextOrdinal.get(signature) ?? 0) + 1;
    if (!state.blockedOrdinal.has(signature) && !state.pendingOrdinal.has(signature)) {
      state.nextOrdinal.set(signature, ordinal);
    }
    state.providerOrdinal.set(providerToolCallId, ordinal);
  }
  const digest = createHash('sha256')
    .update(`${taskId}\u0000${signature}\u0000${String(ordinal)}`)
    .digest('hex');
  return { key: `pi-task:${digest}`, ordinal, signature };
}

type TaskOperationState = {
  readonly nextOrdinal: Map<string, number>;
  readonly pendingOrdinal: Map<string, number>;
  readonly blockedOrdinal: Map<string, number>;
  readonly providerOrdinal: Map<string, number>;
};

async function loadTaskOperationState(
  database: AgentPressDatabase,
  taskId: string,
): Promise<TaskOperationState> {
  const rows = await database
    .select({
      toolId: toolCalls.toolId,
      toolVersion: toolCalls.toolVersion,
      argumentsHash: toolCalls.argumentsHash,
      ordinal: toolCalls.taskOperationOrdinal,
      providerToolCallId: toolCalls.providerToolCallId,
      status: toolCalls.status,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.taskId, taskId), isNotNull(toolCalls.taskOperationKey)))
    .orderBy(toolCalls.createdAt);
  const state: TaskOperationState = {
    nextOrdinal: new Map(),
    pendingOrdinal: new Map(),
    blockedOrdinal: new Map(),
    providerOrdinal: new Map(),
  };
  for (const row of rows) {
    if (!row.ordinal) continue;
    const signature = taskOperationSignature(row.toolId, row.toolVersion, row.argumentsHash);
    if (row.providerToolCallId) state.providerOrdinal.set(row.providerToolCallId, row.ordinal);
    if (row.status === 'outcome_unknown') {
      state.blockedOrdinal.set(signature, row.ordinal);
      continue;
    }
    if (
      row.status === 'proposed' ||
      row.status === 'awaiting_approval' ||
      row.status === 'approved' ||
      row.status === 'executing'
    ) {
      state.pendingOrdinal.set(signature, row.ordinal);
      continue;
    }
    state.nextOrdinal.set(signature, Math.max(state.nextOrdinal.get(signature) ?? 0, row.ordinal));
  }
  return state;
}

function taskOperationSignature(
  toolId: string,
  toolVersion: string,
  argumentsHash: string,
): string {
  return `${toolId}\u0000${toolVersion}\u0000${argumentsHash}`;
}
