import type { ActionEnvelopeV1, ActionSelectedBlock } from '@agentpress/contracts';
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
  'deleted',
] as const);
export const memoryCandidateKindEnum = pgEnum('memory_candidate_kind', [
  'fact',
  'preference',
  'decision',
  'commitment',
  'goal',
  'event',
  'instruction',
  'learning',
  'error',
  'artifact',
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

export const skillRevisionResources = pgTable(
  'skill_revision_resources',
  {
    skillRevisionId: uuid('skill_revision_id')
      .notNull()
      .references(() => skillRevisions.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.skillRevisionId, table.path] }),
    check(
      'skill_revision_resources_size_check',
      sql`${table.byteSize} > 0 and ${table.byteSize} <= 256000`,
    ),
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
    sourceRunId: uuid('source_run_id').references((): AnyPgColumn => agentRuns.id, {
      onDelete: 'set null',
    }),
    sourceToolCallId: uuid('source_tool_call_id').references((): AnyPgColumn => toolCalls.id, {
      onDelete: 'set null',
    }),
    subject: varchar('subject', { length: 200 }).notNull(),
    value: text('value').notNull(),
    valueHash: varchar('value_hash', { length: 80 }).notNull(),
    confidenceBps: integer('confidence_bps').notNull(),
    kind: memoryCandidateKindEnum('kind').notNull().default('fact'),
    importanceBps: integer('importance_bps').notNull().default(5000),
    validFrom: timestamp('valid_from', { withTimezone: true, precision: 3 }),
    validUntil: timestamp('valid_until', { withTimezone: true, precision: 3 }),
    sourceEvidenceIds: jsonb('source_evidence_ids')
      .$type<readonly string[]>()
      .notNull()
      .default([]),
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
    index('memory_candidates_source_run_idx').on(table.sourceRunId),
    check('memory_candidates_confidence_check', sql`${table.confidenceBps} between 0 and 10000`),
    check('memory_candidates_importance_check', sql`${table.importanceBps} between 0 and 10000`),
    check(
      'memory_candidates_validity_check',
      sql`${table.validUntil} is null or ${table.validFrom} is null or ${table.validUntil} > ${table.validFrom}`,
    ),
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
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true, precision: 3 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('conversations_article_default_unique')
      .on(table.articleId)
      .where(sql`${table.articleId} is not null and ${table.isDefault} = true`),
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

export const conversationReadStates = pgTable(
  'conversation_read_states',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => conversationBranches.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt,
  },
  (table) => [primaryKey({ columns: [table.userId, table.branchId] })],
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

export const conversationCompactions = pgTable(
  'conversation_compactions',
  {
    id: uuid('id').primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => conversationBranches.id, { onDelete: 'cascade' }),
    previousCompactionId: uuid('previous_compaction_id').references(
      (): AnyPgColumn => conversationCompactions.id,
      { onDelete: 'set null' },
    ),
    version: integer('version').notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    reason: varchar('reason', { length: 24 }).notNull(),
    sourceFromMessageId: uuid('source_from_message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'restrict' }),
    sourceFromSequence: bigint('source_from_sequence', { mode: 'number' }).notNull(),
    sourceThroughMessageId: uuid('source_through_message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'restrict' }),
    sourceThroughSequence: bigint('source_through_sequence', { mode: 'number' }).notNull(),
    firstKeptMessageId: uuid('first_kept_message_id').references(() => conversationMessages.id, {
      onDelete: 'restrict',
    }),
    firstKeptMessageSequence: bigint('first_kept_message_sequence', { mode: 'number' }),
    summary: text('summary'),
    shortSummary: text('short_summary'),
    tokensBefore: integer('tokens_before').notNull(),
    tokenCount: integer('token_count'),
    preserveData: jsonb('preserve_data').$type<Readonly<Record<string, unknown>>>().notNull(),
    model: varchar('model', { length: 240 }).notNull(),
    promptVersion: varchar('prompt_version', { length: 160 }).notNull(),
    reserveTokens: integer('reserve_tokens').notNull(),
    reserveProvenance: varchar('reserve_provenance', { length: 24 }).notNull(),
    failure: jsonb('failure').$type<{
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
    }>(),
    createdAt,
  },
  (table) => [
    unique('conversation_compactions_branch_version_unique').on(table.branchId, table.version),
    index('conversation_compactions_branch_status_version_idx').on(
      table.branchId,
      table.status,
      table.version,
    ),
    check('conversation_compactions_version_check', sql`${table.version} > 0`),
    check('conversation_compactions_status_check', sql`${table.status} in ('completed', 'failed')`),
    check(
      'conversation_compactions_reason_check',
      sql`${table.reason} in ('automatic', 'manual', 'mid_turn', 'branch_fork')`,
    ),
    check(
      'conversation_compactions_source_range_check',
      sql`${table.sourceFromSequence} > 0 and ${table.sourceThroughSequence} >= ${table.sourceFromSequence}`,
    ),
    check(
      'conversation_compactions_token_check',
      sql`${table.tokensBefore} >= 0 and ${table.reserveTokens} >= 0 and (${table.tokenCount} is null or ${table.tokenCount} >= 0)`,
    ),
    check(
      'conversation_compactions_reserve_provenance_check',
      sql`${table.reserveProvenance} in ('default', 'explicit', 'proportional')`,
    ),
    check(
      'conversation_compactions_result_check',
      sql`(
        ${table.status} = 'completed'
        and length(trim(${table.summary})) > 0
        and ${table.firstKeptMessageId} is not null
        and ${table.firstKeptMessageSequence} > ${table.sourceThroughSequence}
        and ${table.tokenCount} is not null
        and ${table.failure} is null
      ) or (
        ${table.status} = 'failed'
        and ${table.summary} is null
        and ${table.shortSummary} is null
        and ${table.firstKeptMessageId} is null
        and ${table.firstKeptMessageSequence} is null
        and ${table.tokenCount} is null
        and ${table.failure} is not null
      )`,
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
    actionEnvelope: jsonb('action_envelope')
      .$type<ActionEnvelopeV1>()
      .notNull()
      .default(sql`'{"version":1,"source":"free_text","grantedCapabilities":[]}'::jsonb`),
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

/** Durable ownership for a task attempt. A worker crash is represented by an
 * expired lease, never by process-local state. */
export const agentTaskLeases = pgTable(
  'agent_task_leases',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    leaseToken: varchar('lease_token', { length: 160 }).notNull().unique(),
    workerId: varchar('worker_id', { length: 160 }).notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true, precision: 3 }),
    createdAt,
  },
  (table) => [
    unique('agent_task_leases_task_attempt_unique').on(table.taskId, table.attempt),
    index('agent_task_leases_active_idx').on(table.taskId, table.expiresAt, table.releasedAt),
    check('agent_task_leases_attempt_check', sql`${table.attempt} > 0`),
    check('agent_task_leases_expiry_check', sql`${table.expiresAt} > ${table.acquiredAt}`),
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
    content: text('content').notNull().default(''),
    format: varchar('format', { length: 32 }).notNull().default('json'),
    schemaVersion: integer('schema_version').notNull().default(1),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    tokenCount: integer('token_count').notNull(),
    createdAt,
  },
  (table) => [
    unique('context_packs_task_unique').on(table.taskId),
    check('context_packs_token_count_check', sql`${table.tokenCount} >= 0`),
    check('context_packs_schema_version_check', sql`${table.schemaVersion} > 0`),
  ],
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 24 }).notNull(),
    attempt: integer('attempt').notNull().default(1),
    logicalKey: varchar('logical_key', { length: 240 }).notNull(),
    model: varchar('model', { length: 160 }).notNull(),
    promptRevisionId: uuid('prompt_revision_id').references(() => promptRevisions.id, {
      onDelete: 'restrict',
    }),
    status: varchar('status', { length: 24 }).notNull().default('active'),
    nextSequence: bigint('next_sequence', { mode: 'number' }).notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique('agent_sessions_logical_key_unique').on(table.logicalKey),
    index('agent_sessions_run_idx').on(table.runId, table.createdAt),
    check('agent_sessions_kind_check', sql`${table.kind} in ('main', 'specialist')`),
    check(
      'agent_sessions_status_check',
      sql`${table.status} in ('active', 'completed', 'failed', 'interrupted')`,
    ),
    check('agent_sessions_attempt_check', sql`${table.attempt} > 0`),
  ],
);

export const agentTranscriptEntries = pgTable(
  'agent_transcript_entries',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    role: varchar('role', { length: 24 }).notNull(),
    messageType: varchar('message_type', { length: 32 }).notNull(),
    content: jsonb('content').$type<Readonly<Record<string, unknown>>>().notNull(),
    providerToolCallId: varchar('provider_tool_call_id', { length: 240 }),
    createdAt,
  },
  (table) => [
    unique('agent_transcript_entries_session_sequence_unique').on(table.sessionId, table.sequence),
    index('agent_transcript_entries_tool_call_idx').on(table.providerToolCallId),
    check(
      'agent_transcript_entries_role_check',
      sql`${table.role} in ('system', 'user', 'assistant', 'tool', 'application')`,
    ),
  ],
);

export const planRevisionTasks = pgTable(
  'plan_revision_tasks',
  {
    planRevisionId: uuid('plan_revision_id')
      .notNull()
      .references(() => planRevisions.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    sourceRevisionId: uuid('source_revision_id').references(() => planRevisions.id, {
      onDelete: 'set null',
    }),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.planRevisionId, table.taskId] }),
    unique('plan_revision_tasks_position_unique').on(table.planRevisionId, table.position),
    check('plan_revision_tasks_position_check', sql`${table.position} >= 0`),
  ],
);

export const runQuestions = pgTable(
  'run_questions',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    options: jsonb('options').$type<readonly string[]>().notNull(),
    status: varchar('status', { length: 24 }).notNull().default('pending'),
    answer: text('answer'),
    answeredByUserId: uuid('answered_by_user_id').references(() => appUsers.id, {
      onDelete: 'restrict',
    }),
    createdAt,
    answeredAt: timestamp('answered_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    uniqueIndex('run_questions_one_pending_unique')
      .on(table.runId)
      .where(sql`${table.status} = 'pending'`),
    check(
      'run_questions_status_check',
      sql`${table.status} in ('pending', 'answered', 'cancelled')`,
    ),
  ],
);

export const queuedFollowups = pgTable(
  'queued_followups',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    content: text('content').notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    status: varchar('status', { length: 24 }).notNull().default('pending'),
    createdRunId: uuid('created_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt,
    consumedAt: timestamp('consumed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    unique('queued_followups_run_sequence_unique').on(table.runId, table.sequence),
    check(
      'queued_followups_status_check',
      sql`${table.status} in ('pending', 'cancelled', 'consumed')`,
    ),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'set null' }),
    type: varchar('type', { length: 40 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    currentVersion: integer('current_version').notNull().default(1),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('artifacts_run_idx').on(table.runId, table.createdAt),
    check(
      'artifacts_type_check',
      sql`${table.type} in ('ResearchBrief', 'Outline', 'ArticleDraft', 'EditProposal', 'ClaimReview', 'ImagePlan', 'AssetProposal')`,
    ),
  ],
);

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: uuid('id').primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    summary: text('summary').notNull(),
    content: jsonb('content').$type<Readonly<Record<string, unknown>>>().notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    editProposalId: uuid('edit_proposal_id').references(() => editProposals.id, {
      onDelete: 'set null',
    }),
    createdAt,
  },
  (table) => [
    unique('artifact_versions_artifact_version_unique').on(table.artifactId, table.version),
    check('artifact_versions_version_check', sql`${table.version} > 0`),
  ],
);

export const evidenceRecords = pgTable(
  'evidence_records',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'set null' }),
    sourceType: varchar('source_type', { length: 32 }).notNull(),
    sourceUri: text('source_uri'),
    title: text('title').notNull(),
    excerpt: text('excerpt').notNull(),
    sourceRevision: varchar('source_revision', { length: 160 }).notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    metadata: jsonb('metadata').$type<Readonly<Record<string, unknown>>>().notNull(),
    createdAt,
  },
  (table) => [index('evidence_records_run_idx').on(table.runId, table.createdAt)],
);

export const artifactEvidence = pgTable(
  'artifact_evidence',
  {
    artifactVersionId: uuid('artifact_version_id')
      .notNull()
      .references(() => artifactVersions.id, { onDelete: 'cascade' }),
    evidenceId: uuid('evidence_id')
      .notNull()
      .references(() => evidenceRecords.id, { onDelete: 'restrict' }),
    claim: text('claim').notNull(),
    ordinal: integer('ordinal').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactVersionId, table.evidenceId, table.ordinal] }),
    check('artifact_evidence_ordinal_check', sql`${table.ordinal} > 0`),
  ],
);

export const runAttachments = pgTable(
  'run_attachments',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    filename: varchar('filename', { length: 300 }).notNull(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    byteSize: integer('byte_size').notNull(),
    objectKey: text('object_key').notNull(),
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    parseStatus: varchar('parse_status', { length: 24 }).notNull().default('pending'),
    extractedText: text('extracted_text'),
    parseFailure: text('parse_failure'),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('run_attachments_workspace_idx').on(table.workspaceId, table.createdAt),
    check(
      'run_attachments_size_check',
      sql`${table.byteSize} > 0 and ${table.byteSize} <= 20971520`,
    ),
    check(
      'run_attachments_parse_status_check',
      sql`${table.parseStatus} in ('pending', 'ready', 'failed')`,
    ),
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
    providerToolCallId: varchar('provider_tool_call_id', { length: 240 }),
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
    uniqueIndex('tool_calls_run_provider_call_unique')
      .on(table.runId, table.providerToolCallId)
      .where(sql`${table.providerToolCallId} is not null`),
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
      sql`${table.status} in ('pending', 'applied', 'consumed', 'cancelled')`,
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

export const actionProposals = pgTable(
  'action_proposals',
  {
    id: uuid('id').primaryKey(),
    sourceRunId: uuid('source_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    baseRevisionId: uuid('base_revision_id')
      .notNull()
      .references(() => articleRevisions.id, { onDelete: 'restrict' }),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    instruction: text('instruction').notNull(),
    summary: text('summary').notNull(),
    selectedBlocks: jsonb('selected_blocks').$type<readonly ActionSelectedBlock[]>().notNull(),
    grantedCapabilities: jsonb('granted_capabilities').$type<readonly string[]>().notNull(),
    status: varchar('status', { length: 24 }).notNull().default('pending'),
    confirmedRunId: uuid('confirmed_run_id').references(() => agentRuns.id, {
      onDelete: 'restrict',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, precision: 3 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique('action_proposals_source_run_unique').on(table.sourceRunId),
    uniqueIndex('action_proposals_confirmed_run_unique')
      .on(table.confirmedRunId)
      .where(sql`${table.confirmedRunId} is not null`),
    index('action_proposals_article_status_idx').on(table.articleId, table.status),
    check(
      'action_proposals_status_check',
      sql`${table.status} in ('pending', 'confirmed', 'rejected', 'expired')`,
    ),
    check(
      'action_proposals_confirmed_state_check',
      sql`(${table.status} = 'confirmed' and ${table.confirmedRunId} is not null and ${table.confirmedAt} is not null)
          or (${table.status} <> 'confirmed' and ${table.confirmedRunId} is null and ${table.confirmedAt} is null)`,
    ),
  ],
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
    reviewMode: varchar('review_mode', { length: 16 }).notNull().default('granular'),
    diffs: jsonb('diffs')
      .$type<readonly unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceToolCallId: uuid('source_tool_call_id').references(() => toolCalls.id, {
      onDelete: 'set null',
    }),
    status: editProposalStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('edit_proposals_article_status_idx').on(table.articleId, table.status),
    uniqueIndex('edit_proposals_source_tool_call_unique')
      .on(table.sourceToolCallId)
      .where(sql`${table.sourceToolCallId} is not null`),
    uniqueIndex('edit_proposals_one_pending_article_unique')
      .on(table.articleId)
      .where(sql`${table.status} = 'pending'`),
    check('edit_proposals_review_mode_check', sql`${table.reviewMode} in ('granular', 'document')`),
  ],
);

export const editProposalBatches = pgTable(
  'edit_proposal_batches',
  {
    id: uuid('id').primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => editProposals.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    sourceToolCallId: uuid('source_tool_call_id').references(() => toolCalls.id, {
      onDelete: 'restrict',
    }),
    batchNumber: integer('batch_number').notNull(),
    operations: jsonb('operations').$type<readonly unknown[]>().notNull(),
    diffs: jsonb('diffs')
      .$type<readonly unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    beforeHash: varchar('before_hash', { length: 80 }).notNull(),
    afterHash: varchar('after_hash', { length: 80 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique('edit_proposal_batches_proposal_number_unique').on(table.proposalId, table.batchNumber),
    unique('edit_proposal_batches_source_tool_call_unique').on(table.sourceToolCallId),
    index('edit_proposal_batches_proposal_idx').on(table.proposalId, table.batchNumber),
    check('edit_proposal_batches_number_check', sql`${table.batchNumber} > 0`),
    check('edit_proposal_batches_status_check', sql`${table.status} in ('active', 'reverted')`),
  ],
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

export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1024;

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
    embedding: vector('embedding', { dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS }).notNull(),
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

export const evalExperiments = pgTable(
  'eval_experiments',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    datasetVersion: varchar('dataset_version', { length: 160 }).notNull(),
    status: varchar('status', { length: 24 }).notNull().default('draft'),
    config: jsonb('config').$type<Readonly<Record<string, unknown>>>().notNull(),
    createdAt,
    updatedAt,
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    check(
      'eval_experiments_status_check',
      sql`${table.status} in ('draft', 'running', 'completed', 'cancelled', 'failed')`,
    ),
  ],
);

export const evalArms = pgTable(
  'eval_arms',
  {
    id: uuid('id').primaryKey(),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => evalExperiments.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    model: varchar('model', { length: 200 }).notNull(),
    promptVersion: varchar('prompt_version', { length: 160 }).notNull(),
    skillVersions: jsonb('skill_versions').$type<Readonly<Record<string, string>>>().notNull(),
    toolPolicyVersion: varchar('tool_policy_version', { length: 160 }).notNull(),
    contextPolicyVersion: varchar('context_policy_version', { length: 160 }).notNull(),
    createdAt,
  },
  (table) => [unique('eval_arms_experiment_name_unique').on(table.experimentId, table.name)],
);

export const evalTrials = pgTable(
  'eval_trials',
  {
    id: uuid('id').primaryKey(),
    armId: uuid('arm_id')
      .notNull()
      .references(() => evalArms.id, { onDelete: 'cascade' }),
    caseId: varchar('case_id', { length: 200 }).notNull(),
    attempt: integer('attempt').notNull(),
    seed: varchar('seed', { length: 160 }).notNull(),
    status: varchar('status', { length: 24 }).notNull().default('pending'),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    resultMetrics: jsonb('result_metrics')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    processMetrics: jsonb('process_metrics')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    failure: jsonb('failure').$type<Readonly<Record<string, unknown>>>(),
    createdAt,
    updatedAt,
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    unique('eval_trials_arm_case_attempt_unique').on(table.armId, table.caseId, table.attempt),
    index('eval_trials_status_idx').on(table.status, table.updatedAt),
    check('eval_trials_attempt_check', sql`${table.attempt} > 0`),
    check(
      'eval_trials_status_check',
      sql`${table.status} in ('pending', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);

export const evalRunTraces = pgTable(
  'eval_run_traces',
  {
    id: uuid('id').primaryKey(),
    trialId: uuid('trial_id')
      .notNull()
      .references(() => evalTrials.id, { onDelete: 'cascade' }),
    redactedTrace: jsonb('redacted_trace').$type<readonly unknown[]>().notNull(),
    traceHash: varchar('trace_hash', { length: 80 }).notNull(),
    createdAt,
  },
  (table) => [unique('eval_run_traces_trial_unique').on(table.trialId)],
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
