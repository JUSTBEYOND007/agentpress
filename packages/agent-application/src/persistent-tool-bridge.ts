import { createHash } from 'node:crypto';

import type { RuntimeTool } from '@agentpress/agent-runtime';
import {
  agentRuns,
  type AgentPressDatabase,
  rootRequests,
  runSkillBindings,
  skillRevisions,
  workspaceMembers,
} from '@agentpress/database';
import { ToolRegistry } from '@agentpress/tool-runtime';
import { and, eq } from 'drizzle-orm';

import type { RuntimeToolFactory } from './contracts.js';
import { ToolCallApplicationError, ToolCallService } from './tool-call-service.js';

type PersistentToolBridgeOptions = {
  readonly database: AgentPressDatabase;
  readonly registry: ToolRegistry;
  readonly toolCalls: ToolCallService;
  readonly capabilityLimit?: number;
};

export class PersistentToolBridge implements RuntimeToolFactory {
  public constructor(private readonly options: PersistentToolBridgeOptions) {}

  public async listCapabilities(runId: string): Promise<readonly string[]> {
    const { definitions } = await this.authorize(runId);
    return [...new Set(definitions.flatMap(({ capabilities }) => capabilities))].sort();
  }

  public async createForRun(
    runId: string,
    capabilities: readonly string[] = [],
    taskId?: string,
  ): Promise<readonly RuntimeTool[]> {
    const { definitions, requestedByUserId, allowedCapabilities } = await this.authorize(runId);
    const requested = new Set(capabilities);
    return definitions
      .filter(
        (definition) =>
          requested.size === 0 ||
          definition.capabilities.every((capability) => requested.has(capability)),
      )
      .slice(0, this.options.capabilityLimit ?? 16)
      .map((definition) => ({
        name: runtimeToolName(definition.toolId, definition.version),
        label: definition.toolId,
        description: definition.description,
        parameters: definition.inputSchema,
        constrainedSampling: { type: 'json_schema' as const, strict: 'require' as const },
        executionMode: definition.risk === 'read_only' ? 'parallel' : 'sequential',
        execute: async (arguments_, context) => {
          const proposal = await this.options.toolCalls.propose({
            runId,
            ...(taskId ? { taskId } : {}),
            toolId: definition.toolId,
            toolVersion: definition.version,
            arguments: arguments_,
            requestedFromUserId: requestedByUserId,
            allowedCapabilities,
            idempotencyKey: toolIdempotencyKey(runId, context.providerToolCallId),
          });
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
              'invalid_tool_state',
              `Tool Call ${proposal.toolCallId} settled as ${result.status}`,
            );
          }
          return result.output;
        },
      }));
  }

  private async authorize(runId: string) {
    const rows = await this.options.database
      .select({ userId: rootRequests.requestedByUserId, role: workspaceMembers.role })
      .from(agentRuns)
      .innerJoin(rootRequests, eq(rootRequests.id, agentRuns.rootRequestId))
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
      .select({ allowedTools: runSkillBindings.allowedTools })
      .from(runSkillBindings)
      .innerJoin(skillRevisions, eq(skillRevisions.id, runSkillBindings.skillRevisionId))
      .where(eq(runSkillBindings.runId, runId));
    const definitions = this.options.registry
      .list()
      .filter((definition) => authorization.role !== 'viewer' || definition.risk === 'read_only')
      .filter(
        (definition) =>
          skillRows.length === 0 ||
          skillRows.every(({ allowedTools }) => allowedTools.includes(definition.toolId)),
      );
    return {
      definitions,
      requestedByUserId: authorization.userId,
      allowedCapabilities: new Set(
        definitions.flatMap((definition) => [...definition.capabilities]),
      ),
    };
  }
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
