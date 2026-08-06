import type {
  RuntimeCurrentTurn,
  RuntimeMessage,
  RuntimeResult,
  RuntimeTool,
} from '@agentpress/agent-runtime';
import { editProposalBatches, editProposals, type AgentPressDatabase } from '@agentpress/database';
import { Type } from '@sinclair/typebox';
import { and, eq, or } from 'drizzle-orm';

import { ActionProposalService } from './action-proposal-service.js';
import { AgentSessionRunner } from './agent-session-runner.js';
import {
  createAgentTurnProfile,
  selectMainControlTools,
  type AgentTurnProfile,
} from './agent-turn-profile.js';
import type { RuntimeToolFactory } from './contracts.js';
import {
  mainPlanningPrompt,
  planSubmitSchema,
  validateSubmittedPlan,
  type SubmittedPlan,
} from './planned-run-protocol.js';
import { articleEditResult, findAssistant, protocolFailure } from './planned-run-results.js';

export type MainControlDecision =
  | { readonly kind: 'direct'; readonly result: RuntimeResult }
  | { readonly kind: 'plan'; readonly plan: SubmittedPlan; readonly result: RuntimeResult }
  | { readonly kind: 'question'; readonly question: string; readonly options: readonly string[] };

type MainControlServiceOptions = {
  readonly database: AgentPressDatabase;
  readonly sessions: AgentSessionRunner;
  readonly actionProposals: ActionProposalService;
  readonly createId: () => string;
  readonly runtimeToolFactory?: RuntimeToolFactory;
};

export class MainControlService {
  public constructor(private readonly options: MainControlServiceOptions) {}

  public async createTurnProfile(
    runId: string,
    turn: RuntimeCurrentTurn,
  ): Promise<AgentTurnProfile> {
    const capabilities = this.options.runtimeToolFactory
      ? await this.options.runtimeToolFactory.listCapabilities(runId)
      : [];
    return createAgentTurnProfile(turn, capabilities);
  }

  public async run(
    runId: string,
    turn: RuntimeCurrentTurn,
    profile: AgentTurnProfile,
    history: readonly RuntimeMessage[],
    signal?: AbortSignal,
  ): Promise<MainControlDecision> {
    const availableCapabilities = profile.allowedCapabilities;
    let submittedPlan: SubmittedPlan | undefined;
    let requestedQuestion:
      | { readonly question: string; readonly options: readonly string[] }
      | undefined;
    const tools: RuntimeTool[] = [
      this.options.actionProposals.createRuntimeTool(runId),
      {
        name: 'plan_submit',
        label: 'Submit execution plan',
        description:
          'Submit a concrete task DAG only when the authoritative current request needs specialist work or tools.',
        parameters: planSubmitSchema,
        constrainedSampling: { type: 'json_schema', strict: 'require' },
        executionMode: 'sequential',
        terminateOnSuccess: true,
        execute: (arguments_) => {
          submittedPlan = validateSubmittedPlan(
            arguments_,
            availableCapabilities,
            this.options.createId,
          );
          return Promise.resolve({ accepted: true, taskCount: submittedPlan.tasks.length });
        },
      },
      {
        name: 'user_request_input',
        label: 'Request user input',
        description: 'Pause only when required business information is missing.',
        parameters: Type.Object(
          {
            question: Type.String({ minLength: 1, maxLength: 2_000 }),
            options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
              minItems: 2,
              maxItems: 4,
            }),
          },
          { additionalProperties: false },
        ),
        constrainedSampling: { type: 'json_schema', strict: 'require' },
        executionMode: 'sequential',
        terminateOnSuccess: true,
        execute: (arguments_) => {
          requestedQuestion = {
            question: String(arguments_.question),
            options: arguments_.options as readonly string[],
          };
          return Promise.resolve({ accepted: true });
        },
      },
    ];
    const currentTurnTools = selectMainControlTools(profile, tools);
    const articleCapabilities = profile.allowedCapabilities.filter(
      (capability) => capability === 'article.read' || capability === 'article.propose',
    );
    const domainTools =
      profile.kind === 'article_agent' && this.options.runtimeToolFactory
        ? await this.options.runtimeToolFactory.createForRun(runId, articleCapabilities)
        : [];
    const mainTools = [
      ...currentTurnTools,
      ...domainTools.map((tool) => ({
        ...tool,
        ...(tool.label === 'article.propose_edits' ? { terminateOnSuccess: true } : {}),
      })),
    ];
    const result = await this.options.sessions.execute(
      runId,
      undefined,
      'main',
      1,
      'main',
      mainPlanningPrompt(availableCapabilities, turn.actionEnvelope.source),
      history,
      turn,
      mainTools,
      signal,
    );
    const editRows = await this.options.database
      .select({
        id: editProposals.id,
        operations: editProposals.operations,
        reviewMode: editProposals.reviewMode,
      })
      .from(editProposals)
      .leftJoin(editProposalBatches, eq(editProposalBatches.proposalId, editProposals.id))
      .where(
        and(
          eq(editProposals.status, 'pending'),
          or(eq(editProposals.runId, runId), eq(editProposalBatches.runId, runId)),
        ),
      )
      .limit(1);
    if (editRows[0]) return { kind: 'direct', result: articleEditResult(result, editRows[0]) };
    if (await this.options.actionProposals.getBySourceRun(runId)) {
      return { kind: 'direct', result };
    }
    if (submittedPlan) return { kind: 'plan', plan: submittedPlan, result };
    if (requestedQuestion) return { kind: 'question', ...requestedQuestion };
    if (result.status === 'failed') return { kind: 'direct', result };
    if (result.status === 'completed' && findAssistant(result)) return { kind: 'direct', result };
    return {
      kind: 'direct',
      result: protocolFailure(result.messages, 'Main Agent returned no valid control decision'),
    };
  }
}
