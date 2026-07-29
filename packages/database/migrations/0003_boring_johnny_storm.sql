CREATE TYPE "public"."memory_candidate_status" AS ENUM('pending', 'accepted', 'rejected', 'superseded');--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" varchar(200) NOT NULL,
	"value" text NOT NULL,
	"value_hash" varchar(80) NOT NULL,
	"confidence_bps" integer NOT NULL,
	"status" "memory_candidate_status" DEFAULT 'pending' NOT NULL,
	"supersedes_id" uuid,
	"decided_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_candidates_workspace_value_unique" UNIQUE("workspace_id","user_id","subject","value_hash"),
	CONSTRAINT "memory_candidates_confidence_check" CHECK ("memory_candidates"."confidence_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "mention_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_kind" varchar(32) NOT NULL,
	"revision" varchar(120) NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"authorized_user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_bindings_run_target_unique" UNIQUE("run_id","target_id"),
	CONSTRAINT "mention_bindings_kind_check" CHECK ("mention_bindings"."target_kind" in ('article', 'document'))
);
--> statement-breakpoint
CREATE TABLE "model_selections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid,
	"purpose" varchar(80) NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"selected_model" varchar(160) NOT NULL,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"prompt_id" varchar(160) NOT NULL,
	"version" varchar(80) NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_revisions_identity_unique" UNIQUE("prompt_id","version")
);
--> statement-breakpoint
CREATE TABLE "review_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"reviewer" "task_owner" NOT NULL,
	"accepted" boolean NOT NULL,
	"issues" jsonb NOT NULL,
	"input_hash" varchar(80) NOT NULL,
	"output_hash" varchar(80),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_rounds_task_round_unique" UNIQUE("task_id","round"),
	CONSTRAINT "review_rounds_round_check" CHECK ("review_rounds"."round" between 1 and 3),
	CONSTRAINT "review_rounds_reviewer_check" CHECK ("review_rounds"."reviewer" in ('editor', 'fact_checker'))
);
--> statement-breakpoint
CREATE TABLE "skill_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"skill_id" varchar(160) NOT NULL,
	"version" varchar(80) NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"allowed_tools" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_revisions_identity_unique" UNIQUE("workspace_id","skill_id","version")
);
--> statement-breakpoint
ALTER TABLE "context_packs" ADD COLUMN "prompt_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_supersedes_id_memory_candidates_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."memory_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_bindings" ADD CONSTRAINT "mention_bindings_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_bindings" ADD CONSTRAINT "mention_bindings_authorized_user_id_app_users_id_fk" FOREIGN KEY ("authorized_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_selections" ADD CONSTRAINT "model_selections_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_selections" ADD CONSTRAINT "model_selections_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_candidates_retrieval_idx" ON "memory_candidates" USING btree ("workspace_id","user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "model_selections_run_idx" ON "model_selections" USING btree ("run_id","created_at");--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_prompt_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("prompt_revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;