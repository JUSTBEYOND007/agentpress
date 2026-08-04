CREATE TABLE "action_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_run_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"instruction" text NOT NULL,
	"summary" text NOT NULL,
	"selected_blocks" jsonb NOT NULL,
	"granted_capabilities" jsonb NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"confirmed_run_id" uuid,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"confirmed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_proposals_source_run_unique" UNIQUE("source_run_id"),
	CONSTRAINT "action_proposals_status_check" CHECK ("action_proposals"."status" in ('pending', 'confirmed', 'rejected', 'expired')),
	CONSTRAINT "action_proposals_confirmed_state_check" CHECK (("action_proposals"."status" = 'confirmed' and "action_proposals"."confirmed_run_id" is not null and "action_proposals"."confirmed_at" is not null)
          or ("action_proposals"."status" <> 'confirmed' and "action_proposals"."confirmed_run_id" is null and "action_proposals"."confirmed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "root_requests" ADD COLUMN "action_envelope" jsonb DEFAULT '{"version":1,"source":"free_text","grantedCapabilities":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_source_run_id_agent_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_base_revision_id_article_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."article_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_requested_by_user_id_app_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_confirmed_run_id_agent_runs_id_fk" FOREIGN KEY ("confirmed_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_confirmed_run_unique" ON "action_proposals" USING btree ("confirmed_run_id") WHERE "action_proposals"."confirmed_run_id" is not null;--> statement-breakpoint
CREATE INDEX "action_proposals_article_status_idx" ON "action_proposals" USING btree ("article_id","status");
