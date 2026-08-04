CREATE TYPE "public"."memory_candidate_kind" AS ENUM('fact', 'preference', 'decision', 'commitment', 'goal', 'event', 'instruction', 'learning', 'error', 'artifact');--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "kind" "memory_candidate_kind" DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "importance_bps" integer DEFAULT 5000 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "source_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_importance_check" CHECK ("memory_candidates"."importance_bps" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_validity_check" CHECK ("memory_candidates"."valid_until" is null or "memory_candidates"."valid_from" is null or "memory_candidates"."valid_until" > "memory_candidates"."valid_from");
