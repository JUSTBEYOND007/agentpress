CREATE TYPE "public"."agent_run_mode" AS ENUM('direct', 'planned');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'planning', 'running', 'waiting_for_approval', 'waiting_for_user', 'cancelling', 'cancelled', 'interrupted', 'recovering', 'completed', 'completed_with_degradation', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_task_criticality" AS ENUM('required', 'optional');--> statement-breakpoint
CREATE TYPE "public"."agent_task_status" AS ENUM('pending', 'ready', 'running', 'waiting_for_approval', 'interrupted', 'succeeded', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."task_owner" AS ENUM('main', 'researcher', 'writer', 'editor', 'fact_checker', 'illustrator');--> statement-breakpoint
CREATE TYPE "public"."tool_call_status" AS ENUM('proposed', 'awaiting_approval', 'approved', 'denied', 'expired', 'executing', 'succeeded', 'failed', 'outcome_unknown', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tool_risk" AS ENUM('read_only', 'draft_write', 'external_write', 'destructive');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"root_request_id" uuid NOT NULL,
	"mode" "agent_run_mode" NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"active_plan_revision_id" uuid,
	"model_policy_snapshot" jsonb,
	"quota_reservation" jsonb,
	"final_outcome" jsonb,
	"next_event_sequence" bigint DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "agent_runs_root_request_unique" UNIQUE("root_request_id"),
	CONSTRAINT "agent_runs_version_positive_check" CHECK ("agent_runs"."version" > 0),
	CONSTRAINT "agent_runs_next_event_sequence_check" CHECK ("agent_runs"."next_event_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_task_dependencies" (
	"task_id" uuid NOT NULL,
	"dependency_task_id" uuid NOT NULL,
	CONSTRAINT "agent_task_dependencies_task_id_dependency_task_id_pk" PRIMARY KEY("task_id","dependency_task_id"),
	CONSTRAINT "agent_task_dependencies_not_self_check" CHECK ("agent_task_dependencies"."task_id" <> "agent_task_dependencies"."dependency_task_id")
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"objective" text NOT NULL,
	"criticality" "agent_task_criticality" NOT NULL,
	"owner" "task_owner" NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"tool_policy" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"status" "agent_task_status" NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "agent_tasks_attempt_check" CHECK ("agent_tasks"."attempt" >= 0 and "agent_tasks"."attempt" <= "agent_tasks"."max_attempts"),
	CONSTRAINT "agent_tasks_acceptance_criteria_check" CHECK (jsonb_array_length("agent_tasks"."acceptance_criteria") > 0)
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"logto_subject" varchar(128) NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_users_logto_subject_unique" UNIQUE("logto_subject")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tool_call_id" uuid NOT NULL,
	"requested_from_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decision" "approval_decision" DEFAULT 'pending' NOT NULL,
	"tool_version" varchar(80) NOT NULL,
	"arguments_hash" varchar(80) NOT NULL,
	"displayed_side_effect" text NOT NULL,
	"estimated_cost" jsonb NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"decided_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_tool_call_unique" UNIQUE("tool_call_id")
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"reason" varchar(80) NOT NULL,
	"state" jsonb NOT NULL,
	"continuation_cursor" varchar(300),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoints_run_sequence_unique" UNIQUE("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "context_packs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"manifest" jsonb NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"token_count" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_packs_task_unique" UNIQUE("task_id"),
	CONSTRAINT "context_packs_token_count_check" CHECK ("context_packs"."token_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"parent_branch_id" uuid,
	"forked_from_message_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"run_id" uuid,
	"role" varchar(24) NOT NULL,
	"sequence" bigint NOT NULL,
	"content" jsonb NOT NULL,
	"stable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_branch_sequence_unique" UNIQUE("branch_id","sequence"),
	CONSTRAINT "conversation_messages_role_check" CHECK ("conversation_messages"."role" in ('system', 'user', 'assistant', 'tool'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" varchar(300) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_plans_run_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"consumer_group" varchar(180) NOT NULL,
	"message_id" uuid NOT NULL,
	"topic" varchar(180) NOT NULL,
	"partition" integer NOT NULL,
	"offset" bigint NOT NULL,
	"payload_hash" varchar(80) NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp (3) with time zone,
	CONSTRAINT "inbox_messages_consumer_group_message_id_pk" PRIMARY KEY("consumer_group","message_id"),
	CONSTRAINT "inbox_messages_kafka_position_unique" UNIQUE("consumer_group","topic","partition","offset")
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aggregate_type" varchar(100) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"topic" varchar(180) NOT NULL,
	"message_key" varchar(200) NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"available_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp (3) with time zone,
	"locked_by" varchar(160),
	"published_at" timestamp (3) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_attempts_check" CHECK ("outbox_messages"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plan_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"previous_revision_id" uuid,
	"revision_number" integer NOT NULL,
	"reason" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_revisions_plan_number_unique" UNIQUE("plan_id","revision_number"),
	CONSTRAINT "plan_revisions_number_positive_check" CHECK ("plan_revisions"."revision_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "root_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "root_requests_branch_idempotency_unique" UNIQUE("branch_id","idempotency_key"),
	CONSTRAINT "root_requests_message_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"visible_to_user" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_sequence_unique" UNIQUE("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "task_briefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"objective" text NOT NULL,
	"constraints" jsonb NOT NULL,
	"expected_output" jsonb NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_briefs_task_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "task_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"artifacts" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"failure" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_results_task_attempt_unique" UNIQUE("task_id","attempt"),
	CONSTRAINT "task_results_attempt_positive_check" CHECK ("task_results"."attempt" > 0),
	CONSTRAINT "task_results_status_check" CHECK ("task_results"."status" in ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid,
	"tool_id" varchar(180) NOT NULL,
	"tool_version" varchar(80) NOT NULL,
	"arguments" jsonb NOT NULL,
	"arguments_hash" varchar(80) NOT NULL,
	"risk" "tool_risk" NOT NULL,
	"side_effect" text NOT NULL,
	"idempotency_key" varchar(200),
	"status" "tool_call_status" NOT NULL,
	"output" jsonb,
	"failure" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(24) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_branch_id_conversation_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_root_request_id_root_requests_id_fk" FOREIGN KEY ("root_request_id") REFERENCES "public"."root_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_active_plan_revision_id_plan_revisions_id_fk" FOREIGN KEY ("active_plan_revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_dependencies" ADD CONSTRAINT "agent_task_dependencies_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_dependencies" ADD CONSTRAINT "agent_task_dependencies_dependency_task_id_agent_tasks_id_fk" FOREIGN KEY ("dependency_task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_plan_revision_id_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_from_user_id_app_users_id_fk" FOREIGN KEY ("requested_from_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_app_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_branches" ADD CONSTRAINT "conversation_branches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_branches" ADD CONSTRAINT "conversation_branches_parent_branch_id_conversation_branches_id_fk" FOREIGN KEY ("parent_branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_branches" ADD CONSTRAINT "conversation_branches_forked_from_message_id_conversation_messages_id_fk" FOREIGN KEY ("forked_from_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_branch_id_conversation_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_plans" ADD CONSTRAINT "execution_plans_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_plan_id_execution_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."execution_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_previous_revision_id_plan_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "root_requests" ADD CONSTRAINT "root_requests_branch_id_conversation_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "root_requests" ADD CONSTRAINT "root_requests_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_briefs" ADD CONSTRAINT "task_briefs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_results" ADD CONSTRAINT "task_results_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_active_per_branch_unique" ON "agent_runs" USING btree ("branch_id") WHERE "agent_runs"."status" not in ('cancelled', 'completed', 'completed_with_degradation', 'failed');--> statement-breakpoint
CREATE INDEX "agent_runs_workspace_created_idx" ON "agent_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_run_status_idx" ON "agent_tasks" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "agent_tasks_plan_revision_idx" ON "agent_tasks" USING btree ("plan_revision_id");--> statement-breakpoint
CREATE INDEX "checkpoints_run_created_idx" ON "checkpoints" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_branches_conversation_idx" ON "conversation_branches" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_run_idx" ON "conversation_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "conversations_workspace_updated_idx" ON "conversations" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "outbox_messages_dispatch_idx" ON "outbox_messages" USING btree ("published_at","available_at");--> statement-breakpoint
CREATE INDEX "run_events_run_created_idx" ON "run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_run_status_idx" ON "tool_calls" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_idempotency_unique" ON "tool_calls" USING btree ("idempotency_key") WHERE "tool_calls"."idempotency_key" is not null;