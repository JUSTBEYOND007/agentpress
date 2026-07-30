import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';

export const DATABASE_AGENT_RUN_STATES = [
  'queued',
  'planning',
  'running',
  'waiting_for_approval',
  'waiting_for_user',
  'cancelling',
  'cancelled',
  'interrupted',
  'recovering',
  'completed',
  'completed_with_degradation',
  'failed',
] as const;
export const DATABASE_AGENT_TASK_STATES = [
  'pending',
  'ready',
  'running',
  'waiting_for_approval',
  'interrupted',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const DATABASE_TOOL_CALL_STATES = [
  'proposed',
  'awaiting_approval',
  'approved',
  'denied',
  'expired',
  'executing',
  'succeeded',
  'failed',
  'outcome_unknown',
  'cancelled',
] as const;

type AgentRunMode = 'direct' | 'planned';
type AgentTaskCriticality = 'required' | 'optional';
type SpecialistRole = 'researcher' | 'writer' | 'editor' | 'fact_checker' | 'illustrator';
type ToolRisk = 'read_only' | 'draft_write' | 'external_write' | 'destructive';

const createdAt = timestamp('created_at', { withTimezone: true, precision: 3 })
  .notNull()
  .defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true, precision: 3 })
  .notNull()
  .defaultNow();

export const agentRunStatusEnum = pgEnum('agent_run_status', DATABASE_AGENT_RUN_STATES);
export const agentRunModeEnum = pgEnum('agent_run_mode', ['direct', 'planned'] as const);
export const agentTaskStatusEnum = pgEnum('agent_task_status', DATABASE_AGENT_TASK_STATES);
export const agentTaskCriticalityEnum = pgEnum('agent_task_criticality', [
  'required',
  'optional',
] as const);
export const taskOwnerEnum = pgEnum('task_owner', [
  'main',
  'researcher',
  'writer',
  'editor',
  'fact_checker',
  'illustrator',
] as const);
export const toolCallStatusEnum = pgEnum('tool_call_status', DATABASE_TOOL_CALL_STATES);
export const toolRiskEnum = pgEnum('tool_risk', [
  'read_only',
  'draft_write',
  'external_write',
  'destructive',
] as const);
export const approvalDecisionEnum = pgEnum('approval_decision', [
  'pending',
  'approved',
  'denied',
  'expired',
] as const);
export const memoryCandidateStatusEnum = pgEnum('memory_candidate_status', [
  'pending',
  'accepted',
  'rejected',
  'superseded',
] as const);
export const editProposalStatusEnum = pgEnum('edit_proposal_status', [
  'pending',
  'partially_accepted',
  'accepted',
  'rejected',
  'expired',
] as const);
export const mediaAssetKindEnum = pgEnum('media_asset_kind', ['generated', 'licensed'] as const);
export const publicationStatusEnum = pgEnum('publication_status', [
  'published',
  'unpublished',
] as const);

export const appUsers = pgTable('app_users', {
  id: uuid('id').primaryKey(),
  logtoSubject: varchar('logto_subject', { length: 128 }).notNull().unique(),
  displayName: varchar('display_name', { length: 160 }).notNull(),
  createdAt,
  updatedAt,
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  createdAt,
  updatedAt,
});

export const promptRevisions = pgTable(
  'prompt_revisions',
  {
    id: uuid('id').primaryKey(),
    promptId: varchar('prompt_id', { length: 160 }).notNull(),
    version: varchar('version', { length: 80 }).notNull(),
    content: text('content').notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    createdAt,
  },
  (table) => [unique('prompt_revisions_identity_unique').on(table.promptId, table.version)],
);

export const skillRevisions = pgTable(
  'skill_revisions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    skillId: varchar('skill_id', { length: 160 }).notNull(),
    version: varchar('version', { length: 80 }).notNull(),
    content: text('content').notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    allowedTools: jsonb('allowed_tools').$type<readonly string[]>().notNull(),
    createdAt,
  },
  (table) => [
    unique('skill_revisions_identity_unique').on(table.workspaceId, table.skillId, table.version),
  ],
);

export const memoryCandidates = pgTable(
  'memory_candidates',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    subject: varchar('subject', { length: 200 }).notNull(),
    value: text('value').notNull(),
    valueHash: varchar('value_hash', { length: 80 }).notNull(),
    confidenceBps: integer('confidence_bps').notNull(),
    status: memoryCandidateStatusEnum('status').notNull().default('pending'),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => memoryCandidates.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true, precision: 3 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique('memory_candidates_workspace_value_unique').on(
      table.workspaceId,
      table.userId,
      table.subject,
      table.valueHash,
    ),
    index('memory_candidates_retrieval_idx').on(
      table.workspaceId,
      table.userId,
      table.status,
      table.updatedAt,
    ),
    check('memory_candidates_confidence_check', sql`${table.confidenceBps} between 0 and 10000`),
  ],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 24 }).notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    check('workspace_members_role_check', sql`${table.role} in ('owner', 'editor', 'viewer')`),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id').references((): AnyPgColumn => articles.id, {
      onDelete: 'cascade',
    }),
    title: varchar('title', { length: 300 }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique('conversations_article_unique').on(table.articleId),
    index('conversations_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
  ],
);

export const conversationBranches = pgTable(
  'conversation_branches',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    parentBranchId: uuid('parent_branch_id').references(
      (): AnyPgColumn => conversationBranches.id,
      { onDelete: 'set null' },
    ),
    forkedFromMessageId: uuid('forked_from_message_id').references(
      (): AnyPgColumn => conversationMessages.id,
      { onDelete: 'set null' },
    ),
    createdAt,
    updatedAt,
  },
  (table) => [index('conversation_branches_conversation_idx').on(table.conversationId)],
);

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => conversationBranches.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references((): AnyPgColumn => agentRuns.id, { onDelete: 'set null' }),
    role: varchar('role', { length: 24 }).notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    content: jsonb('content').$type<readonly unknown[]>().notNull(),
    stable: boolean('stable').notNull().default(false),
    createdAt,
  },
  (table) => [
    unique('conversation_messages_branch_sequence_unique').on(table.branchId, table.sequence),
    index('conversation_messages_run_idx').on(table.runId),
    check(
      'conversation_messages_role_check',
      sql`${table.role} in ('system', 'user', 'assistant', 'tool')`,
    ),
  ],
);

export const rootRequests = pgTable(
  'root_requests',
  {
    id: uuid('id').primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => conversationBranches.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'restrict' }),
    requestedByUserId: uuid('requested_by_user_id').references(() => appUsers.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    createdAt,
  },
  (table) => [
    unique('root_requests_branch_idempotency_unique').on(table.branchId, table.idempotencyKey),
    unique('root_requests_message_unique').on(table.messageId),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => conversationBranches.id, { onDelete: 'cascade' }),
    rootRequestId: uuid('root_request_id')
      .notNull()
      .references(() => rootRequests.id, { onDelete: 'restrict' }),
    mode: agentRunModeEnum('mode').$type<AgentRunMode>().notNull(),
    status: agentRunStatusEnum('status').notNull(),
    activePlanRevisionId: uuid('active_plan_revision_id').references(
      (): AnyPgColumn => planRevisions.id,
      { onDelete: 'set null' },
    ),
    modelPolicySnapshot: jsonb('model_policy_snapshot').$type<Readonly<Record<string, unknown>>>(),
    quotaReservation: jsonb('quota_reservation').$type<Readonly<Record<string, unknown>>>(),
    finalOutcome: jsonb('final_outcome').$type<Readonly<Record<string, unknown>>>(),
    nextEventSequence: bigint('next_event_sequence', { mode: 'number' }).notNull().default(1),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    unique('agent_runs_root_request_unique').on(table.rootRequestId),
    uniqueIndex('agent_runs_one_active_per_branch_unique')
      .on(table.branchId)
      .where(
        sql`${table.status} not in ('cancelled', 'completed', 'completed_with_degradation', 'failed')`,
      ),
    index('agent_runs_workspace_created_idx').on(table.workspaceId, table.createdAt),
    check('agent_runs_version_positive_check', sql`${table.version} > 0`),
    check('agent_runs_next_event_sequence_check', sql`${table.nextEventSequence} > 0`),
  ],
);

export const executionPlans = pgTable(
  'execution_plans',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    createdAt,
  },
  (table) => [unique('execution_plans_run_unique').on(table.runId)],
);

export const mentionBindings = pgTable(
  'mention_bindings',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id').notNull(),
    targetKind: varchar('target_kind', { length: 32 }).notNull(),
    revision: varchar('revision', { length: 120 }).notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    authorizedUserId: uuid('authorized_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    createdAt,
  },
  (table) => [
    unique('mention_bindings_run_target_unique').on(table.runId, table.targetId),
    check('mention_bindings_kind_check', sql`${table.targetKind} in ('article', 'document')`),
  ],
);

export const runSkillBindings = pgTable(
  'run_skill_bindings',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    skillRevisionId: uuid('skill_revision_id')
      .notNull()
      .references(() => skillRevisions.id, { onDelete: 'restrict' }),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    allowedTools: jsonb('allowed_tools').$type<readonly string[]>().notNull(),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.runId, table.skillRevisionId] })],
);

export const runContextPacks = pgTable(
  'run_context_packs',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    promptRevisionId: uuid('prompt_revision_id')
      .notNull()
      .references(() => promptRevisions.id, { onDelete: 'restrict' }),
    manifest: jsonb('manifest').$type<Readonly<Record<string, unknown>>>().notNull(),
    content: text('content').notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    tokenCount: integer('token_count').notNull(),
    createdAt,
  },
  (table) => [
    unique('run_context_packs_run_unique').on(table.runId),
    check('run_context_packs_token_count_check', sql`${table.tokenCount} >= 0`),
  ],
);

export const planRevisions = pgTable(
  'plan_revisions',
  {
    id: uuid('id').primaryKey(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => executionPlans.id, { onDelete: 'cascade' }),
    previousRevisionId: uuid('previous_revision_id').references(
      (): AnyPgColumn => planRevisions.id,
      { onDelete: 'set null' },
    ),
    revisionNumber: integer('revision_number').notNull(),
    reason: text('reason').notNull(),
    summary: text('summary').notNull(),
    createdAt,
  },
  (table) => [
    unique('plan_revisions_plan_number_unique').on(table.planId, table.revisionNumber),
    check('plan_revisions_number_positive_check', sql`${table.revisionNumber} > 0`),
  ],
);

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    planRevisionId: uuid('plan_revision_id')
      .notNull()
      .references(() => planRevisions.id, { onDelete: 'cascade' }),
    objective: text('objective').notNull(),
    criticality: agentTaskCriticalityEnum('criticality').$type<AgentTaskCriticality>().notNull(),
    owner: taskOwnerEnum('owner').$type<'main' | SpecialistRole>().notNull(),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<readonly string[]>().notNull(),
    outputSchema: jsonb('output_schema').$type<Readonly<Record<string, unknown>>>().notNull(),
    toolPolicy: jsonb('tool_policy').$type<Readonly<Record<string, unknown>>>().notNull(),
    budget: jsonb('budget').$type<Readonly<Record<string, unknown>>>().notNull(),
    status: agentTaskStatusEnum('status').notNull(),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    index('agent_tasks_run_status_idx').on(table.runId, table.status),
    index('agent_tasks_plan_revision_idx').on(table.planRevisionId),
    check(
      'agent_tasks_attempt_check',
      sql`${table.attempt} >= 0 and ${table.attempt} <= ${table.maxAttempts}`,
    ),
    check(
      'agent_tasks_acceptance_criteria_check',
      sql`jsonb_array_length(${table.acceptanceCriteria}) > 0`,
    ),
  ],
);

export const agentTaskDependencies = pgTable(
  'agent_task_dependencies',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    dependencyTaskId: uuid('dependency_task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependencyTaskId] }),
    check(
      'agent_task_dependencies_not_self_check',
      sql`${table.taskId} <> ${table.dependencyTaskId}`,
    ),
  ],
);

export const modelSelections = pgTable(
  'model_selections',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'set null' }),
    purpose: varchar('purpose', { length: 80 }).notNull(),
    policySnapshot: jsonb('policy_snapshot').$type<Readonly<Record<string, unknown>>>().notNull(),
    selectedModel: varchar('selected_model', { length: 160 }).notNull(),
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    createdAt,
  },
  (table) => [index('model_selections_run_idx').on(table.runId, table.createdAt)],
);

export const taskBriefs = pgTable(
  'task_briefs',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    objective: text('objective').notNull(),
    constraints: jsonb('constraints').$type<readonly string[]>().notNull(),
    expectedOutput: jsonb('expected_output').$type<Readonly<Record<string, unknown>>>().notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    createdAt,
  },
  (table) => [unique('task_briefs_task_unique').on(table.taskId)],
);

export const contextPacks = pgTable(
  'context_packs',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    promptRevisionId: uuid('prompt_revision_id').references(() => promptRevisions.id, {
      onDelete: 'restrict',
    }),
    manifest: jsonb('manifest').$type<Readonly<Record<string, unknown>>>().notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    tokenCount: integer('token_count').notNull(),
    createdAt,
  },
  (table) => [
    unique('context_packs_task_unique').on(table.taskId),
    check('context_packs_token_count_check', sql`${table.tokenCount} >= 0`),
  ],
);

export const taskResults = pgTable(
  'task_results',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    artifacts: jsonb('artifacts').$type<readonly unknown[]>().notNull(),
    evidence: jsonb('evidence').$type<readonly unknown[]>().notNull(),
    usage: jsonb('usage').$type<Readonly<Record<string, number>>>().notNull(),
    warnings: jsonb('warnings').$type<readonly string[]>().notNull(),
    failure: jsonb('failure').$type<Readonly<Record<string, unknown>>>(),
    createdAt,
  },
  (table) => [
    unique('task_results_task_attempt_unique').on(table.taskId, table.attempt),
    check('task_results_attempt_positive_check', sql`${table.attempt} > 0`),
    check('task_results_status_check', sql`${table.status} in ('succeeded', 'failed')`),
  ],
);

export const reviewRounds = pgTable(
  'review_rounds',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    reviewer: taskOwnerEnum('reviewer').$type<'editor' | 'fact_checker'>().notNull(),
    accepted: boolean('accepted').notNull(),
    issues: jsonb('issues').$type<readonly string[]>().notNull(),
    inputHash: varchar('input_hash', { length: 80 }).notNull(),
    outputHash: varchar('output_hash', { length: 80 }),
    createdAt,
  },
  (table) => [
    unique('review_rounds_task_round_unique').on(table.taskId, table.round),
    check('review_rounds_round_check', sql`${table.round} between 1 and 3`),
    check('review_rounds_reviewer_check', sql`${table.reviewer} in ('editor', 'fact_checker')`),
  ],
);

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'set null' }),
    toolId: varchar('tool_id', { length: 180 }).notNull(),
    toolVersion: varchar('tool_version', { length: 80 }).notNull(),
    arguments: jsonb('arguments').$type<Readonly<Record<string, unknown>>>().notNull(),
    argumentsHash: varchar('arguments_hash', { length: 80 }).notNull(),
    risk: toolRiskEnum('risk').$type<ToolRisk>().notNull(),
    sideEffect: text('side_effect').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 200 }),
    status: toolCallStatusEnum('status').notNull(),
    output: jsonb('output').$type<unknown>(),
    failure: jsonb('failure').$type<Readonly<Record<string, unknown>>>(),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
    settledAt: timestamp('settled_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    index('tool_calls_run_status_idx').on(table.runId, table.status),
    uniqueIndex('tool_calls_idempotency_unique')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    toolCallId: uuid('tool_call_id')
      .notNull()
      .references(() => toolCalls.id, { onDelete: 'cascade' }),
    requestedFromUserId: uuid('requested_from_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    decidedByUserId: uuid('decided_by_user_id').references(() => appUsers.id, {
      onDelete: 'restrict',
    }),
    decision: approvalDecisionEnum('decision').notNull().default('pending'),
    toolVersion: varchar('tool_version', { length: 80 }).notNull(),
    argumentsHash: varchar('arguments_hash', { length: 80 }).notNull(),
    displayedSideEffect: text('displayed_side_effect').notNull(),
    estimatedCost: jsonb('estimated_cost').$type<Readonly<Record<string, number>>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true, precision: 3 }),
    createdAt,
  },
  (table) => [unique('approvals_tool_call_unique').on(table.toolCallId)],
);

export const checkpoints = pgTable(
  'checkpoints',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    reason: varchar('reason', { length: 80 }).notNull(),
    state: jsonb('state').$type<Readonly<Record<string, unknown>>>().notNull(),
    continuationCursor: varchar('continuation_cursor', { length: 300 }),
    createdAt,
  },
  (table) => [
    unique('checkpoints_run_sequence_unique').on(table.runId, table.sequence),
    index('checkpoints_run_created_idx').on(table.runId, table.createdAt),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    payload: jsonb('payload').$type<Readonly<Record<string, unknown>>>().notNull(),
    visibleToUser: boolean('visible_to_user').notNull().default(true),
    createdAt,
  },
  (table) => [
    unique('run_events_run_sequence_unique').on(table.runId, table.sequence),
    index('run_events_run_created_idx').on(table.runId, table.createdAt),
  ],
);

export const runDirectives = pgTable(
  'run_directives',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    kind: varchar('kind', { length: 24 }).notNull(),
    content: text('content').notNull(),
    status: varchar('status', { length: 24 }).notNull().default('pending'),
    createdAt,
    appliedAt: timestamp('applied_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    unique('run_directives_run_sequence_unique').on(table.runId, table.sequence),
    index('run_directives_run_status_idx').on(table.runId, table.status, table.sequence),
    check('run_directives_kind_check', sql`${table.kind} in ('steering', 'follow_up')`),
    check(
      'run_directives_status_check',
      sql`${table.status} in ('pending', 'applied', 'consumed')`,
    ),
  ],
);

export const contentFolders = pgTable(
  'content_folders',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => contentFolders.id, {
      onDelete: 'cascade',
    }),
    name: varchar('name', { length: 180 }).notNull(),
    position: integer('position').notNull().default(0),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    unique('content_folders_parent_name_unique').on(table.workspaceId, table.parentId, table.name),
    index('content_folders_workspace_parent_idx').on(table.workspaceId, table.parentId),
    check('content_folders_position_check', sql`${table.position} >= 0`),
  ],
);

export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').references(() => contentFolders.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    currentRevisionId: uuid('current_revision_id').references(
      (): AnyPgColumn => articleRevisions.id,
      { onDelete: 'restrict' },
    ),
    version: integer('version').notNull().default(1),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    index('articles_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
    index('articles_folder_updated_idx').on(table.folderId, table.updatedAt),
  ],
);

export const articleRevisions = pgTable(
  'article_revisions',
  {
    id: uuid('id').primaryKey(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    document: jsonb('document').$type<Readonly<Record<string, unknown>>>().notNull(),
    documentHash: varchar('document_hash', { length: 80 }).notNull(),
    source: varchar('source', { length: 32 }).notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    createdAt,
  },
  (table) => [
    unique('article_revisions_article_number_unique').on(table.articleId, table.revisionNumber),
    unique('article_revisions_article_hash_unique').on(table.articleId, table.documentHash),
    check('article_revisions_number_check', sql`${table.revisionNumber} > 0`),
    check('article_revisions_schema_check', sql`${table.schemaVersion} > 0`),
    check(
      'article_revisions_source_check',
      sql`${table.source} in ('manual', 'autosave', 'proposal', 'recovery')`,
    ),
  ],
);

export const articleDrafts = pgTable(
  'article_drafts',
  {
    id: uuid('id').primaryKey(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    writerLeaseId: varchar('writer_lease_id', { length: 160 }).notNull(),
    baseRevisionId: uuid('base_revision_id')
      .notNull()
      .references(() => articleRevisions.id, { onDelete: 'restrict' }),
    schemaVersion: integer('schema_version').notNull(),
    document: jsonb('document').$type<Readonly<Record<string, unknown>>>().notNull(),
    documentHash: varchar('document_hash', { length: 80 }).notNull(),
    serverSequence: bigint('server_sequence', { mode: 'number' }).notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique('article_drafts_article_user_unique').on(table.articleId, table.userId),
    check('article_drafts_schema_check', sql`${table.schemaVersion} > 0`),
    check('article_drafts_sequence_check', sql`${table.serverSequence} >= 0`),
  ],
);

export const autosaveBatches = pgTable(
  'autosave_batches',
  {
    id: uuid('id').primaryKey(),
    updateId: varchar('update_id', { length: 160 }).notNull().unique(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    writerLeaseId: varchar('writer_lease_id', { length: 160 }).notNull(),
    baseRevisionId: uuid('base_revision_id')
      .notNull()
      .references(() => articleRevisions.id, { onDelete: 'restrict' }),
    schemaVersion: integer('schema_version').notNull(),
    steps: jsonb('steps').$type<readonly unknown[]>().notNull(),
    resultingDraftSequence: bigint('resulting_draft_sequence', { mode: 'number' }).notNull(),
    createdAt,
  },
  (table) => [index('autosave_batches_article_created_idx').on(table.articleId, table.createdAt)],
);

export const editProposals = pgTable(
  'edit_proposals',
  {
    id: uuid('id').primaryKey(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    baseRevisionId: uuid('base_revision_id')
      .notNull()
      .references(() => articleRevisions.id, { onDelete: 'restrict' }),
    operations: jsonb('operations').$type<readonly unknown[]>().notNull(),
    status: editProposalStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [index('edit_proposals_article_status_idx').on(table.articleId, table.status)],
);

export const editProposalDecisions = pgTable(
  'edit_proposal_decisions',
  {
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => editProposals.id, { onDelete: 'cascade' }),
    operationId: varchar('operation_id', { length: 160 }).notNull(),
    decision: varchar('decision', { length: 16 }).notNull(),
    decidedByUserId: uuid('decided_by_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.proposalId, table.operationId] }),
    check(
      'edit_proposal_decisions_decision_check',
      sql`${table.decision} in ('accepted', 'rejected')`,
    ),
  ],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    approvedToolCallId: uuid('approved_tool_call_id').references(() => toolCalls.id, {
      onDelete: 'restrict',
    }),
    kind: mediaAssetKindEnum('kind').notNull(),
    objectKey: text('object_key').notNull().unique(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    checksum: varchar('checksum', { length: 80 }).notNull(),
    width: integer('width'),
    height: integer('height'),
    sourceUrl: text('source_url'),
    license: varchar('license', { length: 160 }),
    attribution: text('attribution'),
    prompt: text('prompt'),
    model: varchar('model', { length: 200 }),
    createdAt,
  },
  (table) => [
    index('media_assets_workspace_created_idx').on(table.workspaceId, table.createdAt),
    check('media_assets_size_check', sql`${table.byteSize} > 0`),
    check(
      'media_assets_provenance_check',
      sql`(${table.kind} = 'generated' and ${table.prompt} is not null and ${table.model} is not null)
          or (${table.kind} = 'licensed' and ${table.sourceUrl} is not null and ${table.license} is not null and ${table.attribution} is not null)`,
    ),
  ],
);

export const publicationEditions = pgTable(
  'publication_editions',
  {
    id: uuid('id').primaryKey(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'restrict' }),
    articleRevisionId: uuid('article_revision_id')
      .notNull()
      .references(() => articleRevisions.id, { onDelete: 'restrict' }),
    editionNumber: integer('edition_number').notNull(),
    titleSnapshot: text('title_snapshot').notNull(),
    documentSnapshot: jsonb('document_snapshot')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    coverAssetId: uuid('cover_asset_id').references(() => mediaAssets.id, {
      onDelete: 'restrict',
    }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    createdAt,
  },
  (table) => [
    unique('publication_editions_article_number_unique').on(table.articleId, table.editionNumber),
    check('publication_editions_number_check', sql`${table.editionNumber} > 0`),
  ],
);

export const publications = pgTable(
  'publications',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => publicationEditions.id, { onDelete: 'restrict' }),
    slug: varchar('slug', { length: 180 }).notNull().unique(),
    status: publicationStatusEnum('status').notNull().default('published'),
    publishedAt: timestamp('published_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt,
  },
  (table) => [
    unique('publications_edition_unique').on(table.editionId),
    index('publications_status_published_idx').on(table.status, table.publishedAt),
  ],
);

export const publicationReactions = pgTable(
  'publication_reactions',
  {
    publicationId: uuid('publication_id')
      .notNull()
      .references(() => publications.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    reaction: varchar('reaction', { length: 12 }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.publicationId, table.userId] }),
    check('publication_reactions_value_check', sql`${table.reaction} in ('up', 'down')`),
  ],
);

export const publicationViews = pgTable(
  'publication_views',
  {
    id: uuid('id').primaryKey(),
    publicationId: uuid('publication_id')
      .notNull()
      .references(() => publications.id, { onDelete: 'cascade' }),
    viewerHash: varchar('viewer_hash', { length: 80 }).notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true, precision: 3 }).notNull(),
    createdAt,
  },
  (table) => [
    unique('publication_views_dedupe_unique').on(
      table.publicationId,
      table.viewerHash,
      table.windowStartedAt,
    ),
    index('publication_views_publication_created_idx').on(table.publicationId, table.createdAt),
  ],
);

export const publicationRankings = pgTable(
  'publication_rankings',
  {
    publicationId: uuid('publication_id')
      .primaryKey()
      .references(() => publications.id, { onDelete: 'cascade' }),
    upvotes: integer('upvotes').notNull().default(0),
    downvotes: integer('downvotes').notNull().default(0),
    views: integer('views').notNull().default(0),
    score: integer('score').notNull().default(0),
    updatedAt,
  },
  (table) => [
    index('publication_rankings_score_idx').on(table.score, table.updatedAt),
    check(
      'publication_rankings_counts_check',
      sql`${table.upvotes} >= 0 and ${table.downvotes} >= 0 and ${table.views} >= 0`,
    ),
  ],
);

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceUri: text('source_uri').notNull(),
    title: text('title').notNull(),
    revisionHash: varchar('revision_hash', { length: 80 }).notNull(),
    acl: jsonb('acl').$type<readonly string[]>().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique('knowledge_documents_source_revision_unique').on(
      table.workspaceId,
      table.sourceUri,
      table.revisionHash,
    ),
    index('knowledge_documents_workspace_idx').on(table.workspaceId, table.updatedAt),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    content: text('content').notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    tokenCount: integer('token_count').notNull(),
    createdAt,
  },
  (table) => [
    unique('knowledge_chunks_document_ordinal_unique').on(table.documentId, table.ordinal),
    index('knowledge_chunks_fts_idx').using('gin', sql`to_tsvector('simple', ${table.content})`),
    index('knowledge_chunks_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
    check('knowledge_chunks_ordinal_check', sql`${table.ordinal} >= 0`),
    check('knowledge_chunks_token_count_check', sql`${table.tokenCount} > 0`),
  ],
);

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    aggregateType: varchar('aggregate_type', { length: 100 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    topic: varchar('topic', { length: 180 }).notNull(),
    messageKey: varchar('message_key', { length: 200 }).notNull(),
    payload: jsonb('payload').$type<Readonly<Record<string, unknown>>>().notNull(),
    headers: jsonb('headers').$type<Readonly<Record<string, string>>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true, precision: 3 }),
    lockedBy: varchar('locked_by', { length: 160 }),
    publishedAt: timestamp('published_at', { withTimezone: true, precision: 3 }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt,
  },
  (table) => [
    index('outbox_messages_dispatch_idx').on(table.publishedAt, table.availableAt),
    check('outbox_messages_attempts_check', sql`${table.attempts} >= 0`),
  ],
);

export const inboxMessages = pgTable(
  'inbox_messages',
  {
    consumerGroup: varchar('consumer_group', { length: 180 }).notNull(),
    messageId: uuid('message_id').notNull(),
    topic: varchar('topic', { length: 180 }).notNull(),
    partition: integer('partition').notNull(),
    offset: bigint('offset', { mode: 'number' }).notNull(),
    payloadHash: varchar('payload_hash', { length: 80 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    primaryKey({ columns: [table.consumerGroup, table.messageId] }),
    unique('inbox_messages_kafka_position_unique').on(
      table.consumerGroup,
      table.topic,
      table.partition,
      table.offset,
    ),
  ],
);
