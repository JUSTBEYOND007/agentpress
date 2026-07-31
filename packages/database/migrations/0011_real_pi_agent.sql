CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid,
	"kind" varchar(24) NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"logical_key" varchar(240) NOT NULL,
	"model" varchar(160) NOT NULL,
	"prompt_revision_id" uuid,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_logical_key_unique" UNIQUE("logical_key"),
	CONSTRAINT "agent_sessions_kind_check" CHECK ("agent_sessions"."kind" in ('main', 'specialist')),
	CONSTRAINT "agent_sessions_status_check" CHECK ("agent_sessions"."status" in ('active', 'completed', 'failed')),
	CONSTRAINT "agent_sessions_attempt_check" CHECK ("agent_sessions"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_transcript_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"role" varchar(24) NOT NULL,
	"message_type" varchar(32) NOT NULL,
	"content" jsonb NOT NULL,
	"provider_tool_call_id" varchar(240),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_transcript_entries_session_sequence_unique" UNIQUE("session_id","sequence"),
	CONSTRAINT "agent_transcript_entries_role_check" CHECK ("agent_transcript_entries"."role" in ('system', 'user', 'assistant', 'tool', 'application'))
);
--> statement-breakpoint
CREATE TABLE "artifact_evidence" (
	"artifact_version_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"claim" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "artifact_evidence_artifact_version_id_evidence_id_ordinal_pk" PRIMARY KEY("artifact_version_id","evidence_id","ordinal"),
	CONSTRAINT "artifact_evidence_ordinal_check" CHECK ("artifact_evidence"."ordinal" > 0)
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"summary" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"edit_proposal_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_artifact_version_unique" UNIQUE("artifact_id","version"),
	CONSTRAINT "artifact_versions_version_check" CHECK ("artifact_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid,
	"type" varchar(40) NOT NULL,
	"title" varchar(300) NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_type_check" CHECK ("artifacts"."type" in ('ResearchBrief', 'Outline', 'ArticleDraft', 'EditProposal', 'ClaimReview', 'ImagePlan', 'AssetProposal'))
);
--> statement-breakpoint
CREATE TABLE "evidence_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid,
	"source_type" varchar(32) NOT NULL,
	"source_uri" text,
	"title" text NOT NULL,
	"excerpt" text NOT NULL,
	"source_revision" varchar(160) NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_revision_tasks" (
	"plan_revision_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"source_revision_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_revision_tasks_plan_revision_id_task_id_pk" PRIMARY KEY("plan_revision_id","task_id"),
	CONSTRAINT "plan_revision_tasks_position_unique" UNIQUE("plan_revision_id","position"),
	CONSTRAINT "plan_revision_tasks_position_check" CHECK ("plan_revision_tasks"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "queued_followups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"content" text NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_run_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	CONSTRAINT "queued_followups_run_sequence_unique" UNIQUE("run_id","sequence"),
	CONSTRAINT "queued_followups_status_check" CHECK ("queued_followups"."status" in ('pending', 'cancelled', 'consumed'))
);
--> statement-breakpoint
CREATE TABLE "run_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"filename" varchar(300) NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"byte_size" integer NOT NULL,
	"object_key" text NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"parse_status" varchar(24) DEFAULT 'pending' NOT NULL,
	"extracted_text" text,
	"parse_failure" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_attachments_size_check" CHECK ("run_attachments"."byte_size" > 0 and "run_attachments"."byte_size" <= 20971520),
	CONSTRAINT "run_attachments_parse_status_check" CHECK ("run_attachments"."parse_status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "run_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"answer" text,
	"answered_by_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp (3) with time zone,
	CONSTRAINT "run_questions_status_check" CHECK ("run_questions"."status" in ('pending', 'answered', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_article_unique";--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "content" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "format" varchar(32) DEFAULT 'json' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "archived_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "conversations" SET "is_default" = true WHERE "article_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_prompt_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("prompt_revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transcript_entries" ADD CONSTRAINT "agent_transcript_entries_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evidence" ADD CONSTRAINT "artifact_evidence_evidence_id_evidence_records_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_edit_proposal_id_edit_proposals_id_fk" FOREIGN KEY ("edit_proposal_id") REFERENCES "public"."edit_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revision_tasks" ADD CONSTRAINT "plan_revision_tasks_plan_revision_id_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revision_tasks" ADD CONSTRAINT "plan_revision_tasks_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revision_tasks" ADD CONSTRAINT "plan_revision_tasks_source_revision_id_plan_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queued_followups" ADD CONSTRAINT "queued_followups_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queued_followups" ADD CONSTRAINT "queued_followups_requested_by_user_id_app_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queued_followups" ADD CONSTRAINT "queued_followups_created_run_id_agent_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attachments" ADD CONSTRAINT "run_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attachments" ADD CONSTRAINT "run_attachments_uploaded_by_user_id_app_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_questions" ADD CONSTRAINT "run_questions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_questions" ADD CONSTRAINT "run_questions_answered_by_user_id_app_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_run_idx" ON "agent_sessions" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_transcript_entries_tool_call_idx" ON "agent_transcript_entries" USING btree ("provider_tool_call_id");--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_records_run_idx" ON "evidence_records" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "run_attachments_workspace_idx" ON "run_attachments" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_questions_one_pending_unique" ON "run_questions" USING btree ("run_id") WHERE "run_questions"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_article_default_unique" ON "conversations" USING btree ("article_id") WHERE "conversations"."article_id" is not null and "conversations"."is_default" = true;--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_schema_version_check" CHECK ("context_packs"."schema_version" > 0);
