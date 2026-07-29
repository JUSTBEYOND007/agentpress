CREATE TYPE "public"."edit_proposal_status" AS ENUM('pending', 'partially_accepted', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "article_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"writer_lease_id" varchar(160) NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"document_hash" varchar(80) NOT NULL,
	"server_sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_drafts_article_user_unique" UNIQUE("article_id","user_id"),
	CONSTRAINT "article_drafts_schema_check" CHECK ("article_drafts"."schema_version" > 0),
	CONSTRAINT "article_drafts_sequence_check" CHECK ("article_drafts"."server_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "article_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"document_hash" varchar(80) NOT NULL,
	"source" varchar(32) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_revisions_article_number_unique" UNIQUE("article_id","revision_number"),
	CONSTRAINT "article_revisions_article_hash_unique" UNIQUE("article_id","document_hash"),
	CONSTRAINT "article_revisions_number_check" CHECK ("article_revisions"."revision_number" > 0),
	CONSTRAINT "article_revisions_schema_check" CHECK ("article_revisions"."schema_version" > 0),
	CONSTRAINT "article_revisions_source_check" CHECK ("article_revisions"."source" in ('manual', 'autosave', 'proposal', 'recovery'))
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"current_revision_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autosave_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"update_id" varchar(160) NOT NULL,
	"article_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"writer_lease_id" varchar(160) NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"steps" jsonb NOT NULL,
	"resulting_draft_sequence" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autosave_batches_update_id_unique" UNIQUE("update_id")
);
--> statement-breakpoint
CREATE TABLE "edit_proposal_decisions" (
	"proposal_id" uuid NOT NULL,
	"operation_id" varchar(160) NOT NULL,
	"decision" varchar(16) NOT NULL,
	"decided_by_user_id" uuid NOT NULL,
	"decided_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edit_proposal_decisions_proposal_id_operation_id_pk" PRIMARY KEY("proposal_id","operation_id"),
	CONSTRAINT "edit_proposal_decisions_decision_check" CHECK ("edit_proposal_decisions"."decision" in ('accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "edit_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" uuid NOT NULL,
	"run_id" uuid,
	"base_revision_id" uuid NOT NULL,
	"operations" jsonb NOT NULL,
	"status" "edit_proposal_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_drafts" ADD CONSTRAINT "article_drafts_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_drafts" ADD CONSTRAINT "article_drafts_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_drafts" ADD CONSTRAINT "article_drafts_base_revision_id_article_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."article_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_current_revision_id_article_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."article_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autosave_batches" ADD CONSTRAINT "autosave_batches_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autosave_batches" ADD CONSTRAINT "autosave_batches_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autosave_batches" ADD CONSTRAINT "autosave_batches_base_revision_id_article_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."article_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposal_decisions" ADD CONSTRAINT "edit_proposal_decisions_proposal_id_edit_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."edit_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposal_decisions" ADD CONSTRAINT "edit_proposal_decisions_decided_by_user_id_app_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_base_revision_id_article_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."article_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "articles_workspace_updated_idx" ON "articles" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "autosave_batches_article_created_idx" ON "autosave_batches" USING btree ("article_id","created_at");--> statement-breakpoint
CREATE INDEX "edit_proposals_article_status_idx" ON "edit_proposals" USING btree ("article_id","status");