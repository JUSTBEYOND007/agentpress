ALTER TABLE "review_rounds" ADD COLUMN "artifact_version_id" uuid;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD COLUMN "score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD COLUMN "model_parse_failed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD COLUMN "deterministic_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD COLUMN "model_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD COLUMN "usage" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD COLUMN "selection_reason" varchar(48);--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_score_check" CHECK ("review_rounds"."score" between 0 and 100);