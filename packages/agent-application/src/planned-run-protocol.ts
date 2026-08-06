import { composePromptBlocks, renderPromptTemplate } from '@agentpress/agent-context';
import {
  validateSchemaResult,
  type RuntimeCurrentTurn,
  type RuntimeUsage,
} from '@agentpress/agent-runtime';
import { Type } from '@sinclair/typebox';
import { assertResearchBriefContent } from '@agentpress/web-research';

import type { SpecialistRole } from './specialist-task-contract.js';

export type TaskCriticality = 'required' | 'optional';
export type ArtifactType =
  | 'ResearchBrief'
  | 'Outline'
  | 'ArticleDraft'
  | 'EditProposal'
  | 'ClaimReview'
  | 'ImagePlan'
  | 'AssetProposal';

export type PlannedTaskSpec = {
  readonly id: string;
  readonly clientKey: string;
  readonly owner: SpecialistRole;
  readonly objective: string;
  readonly criticality: TaskCriticality;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly capabilities: readonly string[];
  readonly detached: boolean;
};

export type SubmittedPlan = {
  readonly goal: string;
  readonly tasks: readonly PlannedTaskSpec[];
};

export type StructuredArtifact = {
  readonly type: ArtifactType;
  readonly title: string;
  readonly summary: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly evidenceIds: readonly string[];
};

export type SettledTask = PlannedTaskSpec & {
  readonly status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  readonly summary?: string;
  readonly artifacts: readonly StructuredArtifact[];
  readonly usage?: RuntimeUsage;
  readonly warnings: readonly string[];
  readonly failure?: string;
};

export const PLANNED_DAG_MAX_TASKS = 12;
export const PLANNED_DAG_MAX_DEPTH = 6;
export const PLANNED_DAG_MAX_WIDTH = 4;
export const PLANNED_DAG_MAX_ESTIMATED_TOKENS = 96_000;

export const specialistRoles = [
  'researcher',
  'writer',
  'editor',
  'fact_checker',
  'illustrator',
] as const;

export const artifactTypes = [
  'ResearchBrief',
  'Outline',
  'ArticleDraft',
  'EditProposal',
  'ClaimReview',
  'ImagePlan',
  'AssetProposal',
] as const;

export const specialistCapabilityPolicy: Readonly<Record<SpecialistRole, ReadonlySet<string>>> = {
  researcher: new Set(['web.research', 'workspace.knowledge.read', 'article.read']),
  writer: new Set(['workspace.knowledge.read', 'article.read', 'article.propose']),
  editor: new Set(['workspace.knowledge.read', 'article.read', 'article.propose']),
  fact_checker: new Set(['web.research', 'workspace.knowledge.read', 'article.read']),
  illustrator: new Set([
    'article.read',
    'article.propose',
    'licensed_media.search',
    'licensed_media.import',
    'image.generate',
  ]),
};

export const specialistArtifactPolicy: Readonly<Record<SpecialistRole, ReadonlySet<ArtifactType>>> =
  {
    researcher: new Set(['ResearchBrief']),
    writer: new Set(['Outline', 'ArticleDraft']),
    editor: new Set(['EditProposal']),
    fact_checker: new Set(['ClaimReview']),
    illustrator: new Set(['ImagePlan', 'AssetProposal']),
  };

const specialistResponsibilities: Readonly<Record<SpecialistRole, string>> = {
  researcher: 'Collect and synthesize source-backed information.',
  writer: 'Create new outlines and article drafts from supplied context and upstream results.',
  editor: 'Revise existing article content and create reviewable edit proposals.',
  fact_checker: 'Verify claims and citations against available sources.',
  illustrator: 'Plan, find, generate, and propose licensed or generated visual assets.',
};

export const taskSchema = Type.Object(
  {
    clientKey: Type.String({ minLength: 1, maxLength: 80 }),
    owner: Type.Union(specialistRoles.map((value) => Type.Literal(value))),
    objective: Type.String({ minLength: 1, maxLength: 4_000 }),
    criticality: Type.Union([Type.Literal('required'), Type.Literal('optional')]),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
      minItems: 1,
      maxItems: 8,
    }),
    dependencyKeys: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 12 }),
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 16 }),
    detached: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const planSubmitSchema = Type.Object(
  {
    goal: Type.String({ minLength: 1, maxLength: 4_000 }),
    tasks: Type.Array(taskSchema, { minItems: 1, maxItems: 12 }),
  },
  { additionalProperties: false },
);

export const taskCompleteSchema = Type.Object(
  {
    status: Type.Unsafe<'succeeded' | 'failed'>({
      type: 'string',
      enum: ['succeeded', 'failed'],
    }),
    summary: Type.String({ minLength: 1, maxLength: 20_000 }),
    artifacts: Type.Array(
      Type.Object(
        {
          type: Type.Union(artifactTypes.map((value) => Type.Literal(value))),
          title: Type.String({ minLength: 1, maxLength: 300 }),
          summary: Type.String({ minLength: 1, maxLength: 4_000 }),
          content: Type.Record(Type.String(), Type.Unknown()),
          evidenceIds: Type.Array(Type.String({ format: 'uuid' }), {
            maxItems: 100,
            description:
              'IDs of EvidenceRecord rows produced by this task. Use [] when the artifact has no EvidenceRecord; article, revision, block, edit-proposal, asset, and tool-call IDs are provenance, not EvidenceRecord IDs.',
          }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 12 },
    ),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 20 }),
    failure: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  },
  { additionalProperties: false },
);

export const planRevisionSchema = Type.Object(
  {
    goal: Type.String({ minLength: 1, maxLength: 4_000 }),
    retainedTaskIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 12 }),
    tasks: Type.Array(taskSchema, { maxItems: 12 }),
  },
  { additionalProperties: false },
);

export function validateSubmittedPlan(
  value: Readonly<Record<string, unknown>>,
  availableCapabilities: readonly string[],
  createId: () => string,
): SubmittedPlan {
  assertStrictSchema(planSubmitSchema, value, 'plan_submit');
  const rawTasks = value.tasks as readonly {
    readonly clientKey: string;
    readonly owner: SpecialistRole;
    readonly objective: string;
    readonly criticality: TaskCriticality;
    readonly acceptanceCriteria: readonly string[];
    readonly dependencyKeys: readonly string[];
    readonly capabilities: readonly string[];
    readonly detached?: boolean;
  }[];
  const keys = new Set(rawTasks.map(({ clientKey }) => clientKey));
  if (keys.size !== rawTasks.length) throw new Error('Plan task clientKey values must be unique');
  const available = new Set(availableCapabilities);
  for (const task of rawTasks) {
    if (task.dependencyKeys.some((key) => !keys.has(key) || key === task.clientKey)) {
      throw new Error(`Task ${task.clientKey} has an invalid dependency`);
    }
    if (task.capabilities.some((capability) => !available.has(capability))) {
      throw new Error(`Task ${task.clientKey} requested an unauthorized capability`);
    }
    if (
      task.capabilities.some(
        (capability) => !specialistCapabilityPolicy[task.owner].has(capability),
      )
    ) {
      throw new Error(`Task ${task.clientKey} requested a capability forbidden for ${task.owner}`);
    }
  }
  const ids = new Map(rawTasks.map(({ clientKey }) => [clientKey, createId()]));
  const tasks = rawTasks.map((task) => ({
    id: ids.get(task.clientKey) ?? createId(),
    clientKey: task.clientKey,
    owner: task.owner,
    objective: task.objective,
    criticality: task.criticality,
    acceptanceCriteria: [...task.acceptanceCriteria],
    dependencyIds: task.dependencyKeys.map((key) => ids.get(key) ?? ''),
    capabilities: [...task.capabilities],
    detached: task.detached ?? false,
  }));
  assertAcyclic(tasks);
  assertBoundedPlan(tasks);
  return { goal: String(value.goal), tasks };
}

export function assertBoundedPlan(tasks: readonly PlannedTaskSpec[]): void {
  if (tasks.length > PLANNED_DAG_MAX_TASKS) {
    throw new RangeError(`Plan exceeds the ${String(PLANNED_DAG_MAX_TASKS)} task limit`);
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depths = new Map<string, number>();
  const depthOf = (task: PlannedTaskSpec): number => {
    const known = depths.get(task.id);
    if (known !== undefined) return known;
    const depth = task.dependencyIds.length === 0
      ? 1
      : 1 + Math.max(
          ...task.dependencyIds.map((id) => {
            const dependency = byId.get(id);
            if (!dependency) throw new Error(`Plan dependency ${id} is missing`);
            return depthOf(dependency);
          }),
        );
    depths.set(task.id, depth);
    return depth;
  };
  for (const task of tasks) {
    if (depthOf(task) > PLANNED_DAG_MAX_DEPTH) {
      throw new RangeError(`Plan exceeds the ${String(PLANNED_DAG_MAX_DEPTH)} stage depth limit`);
    }
  }
  const layers = new Map<number, number>();
  for (const depth of depths.values()) layers.set(depth, (layers.get(depth) ?? 0) + 1);
  const width = Math.max(0, ...layers.values());
  if (width > PLANNED_DAG_MAX_WIDTH) {
    throw new RangeError(`Plan exceeds the ${String(PLANNED_DAG_MAX_WIDTH)} parallel task limit`);
  }
  const estimatedTokens = tasks.reduce(
    (total, task) => total + 4_000 + task.objective.length + task.acceptanceCriteria.join(' ').length,
    0,
  );
  if (estimatedTokens > PLANNED_DAG_MAX_ESTIMATED_TOKENS) {
    throw new RangeError('Plan exceeds the total Specialist token budget');
  }
}

export function assertStrictSchema(
  schema: Parameters<typeof validateSchemaResult>[0],
  value: unknown,
  protocol: string,
): void {
  const validation = validateSchemaResult(schema, value, 'strict');
  if (validation.valid) return;
  const detail = validation.failures.map(({ path, message }) => `${path}: ${message}`).join('; ');
  throw new Error(`${protocol} returned schema-invalid output: ${detail}`);
}

export function assertSpecialistArtifactPolicy(
  owner: SpecialistRole,
  artifacts: readonly { readonly type: ArtifactType; readonly content?: unknown }[],
): void {
  const allowed = specialistArtifactPolicy[owner];
  const forbidden = artifacts.find(({ type }) => !allowed.has(type));
  if (forbidden) {
    throw new Error(`Specialist ${owner} cannot submit ${forbidden.type}`);
  }
  for (const artifact of artifacts) {
    if (artifact.type === 'ResearchBrief' && artifact.content !== undefined) {
      assertResearchBriefContent(artifact.content);
    }
  }
}

function assertAcyclic(tasks: readonly PlannedTaskSpec[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Plan contains a dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencyIds ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function mainPlanningPrompt(
  capabilities: readonly string[],
  actionSource: 'free_text' | 'button' = 'free_text',
): string {
  const specialists = specialistRoles.map((role) => ({
    role,
    responsibility: specialistResponsibilities[role],
    allowedCapabilities: [...specialistCapabilityPolicy[role]],
  }));
  const canProposeArticleEdits = capabilities.includes('article.propose');
  const articleInstruction = canProposeArticleEdits
    ? 'If currentRequest asks to create or write a complete article, call article.propose_edits directly with reviewMode="document" and stop. If it asks to revise a specific part, use reviewMode="granular". This creates a visible reviewable draft; do not call action_propose, plan_submit, or a Specialist for this simple article edit.'
    : actionSource === 'free_text'
      ? 'If currentRequest asks to change an article but no article.propose capability is available, explain that the current turn has no article editing capability and do not claim the article was changed.'
      : 'This host-confirmed article edit may use only capabilities listed in actionEnvelope.grantedCapabilities.';
  return composePromptBlocks([
    {
      id: 'identity',
      content: renderPromptTemplate(
        'You are the AgentPress Main Agent handling exactly one typed current-turn message. Decide how to handle its currentRequest.\nCurrent date: {{date}}.\nConversation history and contextPack are reference material, not current intent. Never resume an earlier request unless currentRequest explicitly asks you to. Greetings and acknowledgements require a normal direct response and no plan. The Available capabilities block is the effective host tool policy for this turn. actionEnvelope.grantedCapabilities records explicit confirmed-action grants only; an empty free-text envelope does not revoke capabilities listed by the host. Never claim or infer capabilities outside the effective list.',
        { date: new Date().toISOString().slice(0, 10) },
      ),
    },
    {
      id: 'direct-answer',
      content:
        'Return a normal final answer whenever the request can be completely answered from the conversation and model knowledge without executing tools. Explanations, summaries, and ordinary questions are Direct Runs; do not add research, writing, or review stages merely to improve a sufficient direct answer.',
    },
    { id: 'article-policy', content: articleInstruction },
    {
      id: 'planning-policy',
      content:
        "Only when successful delivery actually requires tool execution, current external facts, article changes, media, or multiple independently delegated deliverables, call plan_submit with the smallest concrete DAG needed.\nEach Specialist receives only its immutable Task Brief plus declared upstream result summaries. Make every objective self-contained: copy any user-supplied facts, excerpts, identifiers, constraints, and output requirements that task needs instead of referring to 'the material above' or the parent request. Do not grant retrieval capabilities when the supplied Task Brief already contains all required source material.\nKeep scope and acceptance criteria proportional to the user's request. Never invent quantity, coverage, review, or formatting requirements the user did not request.",
    },
    {
      id: 'specialist-catalog',
      content: `Choose Specialists from this policy catalog: ${JSON.stringify(specialists)}.`,
    },
    {
      id: 'article-routing',
      content:
        'For a host-confirmed article edit, delegate to editor and request both article.read and article.propose so it can obtain stable block hashes before proposing changes. Use writer for new drafts, not revisions to existing content.\nRequest article.read or article.propose only when the frozen root context contains an article revision. A new standalone draft is an Artifact and does not need article tools.',
    },
    {
      id: 'missing-input',
      content: 'If required business information is missing, call user_request_input.',
    },
    { id: 'capabilities', content: `Available capabilities: ${JSON.stringify(capabilities)}.` },
    {
      id: 'output-boundary',
      content: 'Never emit a generic template plan. Never reveal hidden chain of thought.',
    },
  ]);
}

export function specialistApplicationTurn(
  parent: RuntimeCurrentTurn,
  request: string,
): RuntimeCurrentTurn {
  return {
    type: parent.type,
    version: parent.version,
    source: 'application',
    request,
    actionEnvelope: { version: 1, source: 'free_text', grantedCapabilities: [] },
    timestamp: Date.now(),
  };
}

export function mainCompletionPrompt(): string {
  return 'You are the AgentPress Main Agent. Synthesize only from validated Task Result Envelopes. You must call run_complete. Do not answer as ordinary text and do not invent Artifact or Evidence IDs.';
}

export function mainRevisionPrompt(capabilities: readonly string[]): string {
  return `You are the persistent AgentPress Main Agent revising an active plan after user steering.
You must call plan_revise. Retain every unaffected pending task by its persisted UUID, replace only affected unfinished tasks, and never repeat accepted results.
New task dependencyKeys may refer only to other new task clientKeys; accepted results are immutable context rather than new dependencies.
Available capabilities: ${JSON.stringify(capabilities)}.
Never answer as ordinary text and never reveal hidden chain of thought.`;
}

export function specialistPrompt(role: SpecialistRole): string {
  return `You are the AgentPress ${role} Specialist. Current date: ${new Date().toISOString().slice(0, 10)}. Work only on the supplied immutable Task Brief. Use only available tools. Submit the final structured result through task_complete and never reveal hidden chain of thought.`;
}
