ALTER TABLE "eval_trials" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD COLUMN "worker_id" varchar(200);--> statement-breakpoint
ALTER TABLE "eval_trials" ADD COLUMN "claimed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD COLUMN "lease_expires_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD CONSTRAINT "eval_trials_lease_check" CHECK (("eval_trials"."claim_token" is null and "eval_trials"."worker_id" is null and "eval_trials"."claimed_at" is null and "eval_trials"."lease_expires_at" is null) or ("eval_trials"."claim_token" is not null and "eval_trials"."worker_id" is not null and "eval_trials"."claimed_at" is not null and "eval_trials"."lease_expires_at" is not null));