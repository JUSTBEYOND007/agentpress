CREATE TABLE "eval_experiments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"dataset_version" varchar(160) NOT NULL,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "eval_experiments_status_check" CHECK ("eval_experiments"."status" in ('draft', 'running', 'completed', 'cancelled', 'failed'))
);--> statement-breakpoint
CREATE TABLE "eval_arms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"model" varchar(200) NOT NULL,
	"prompt_version" varchar(160) NOT NULL,
	"skill_versions" jsonb NOT NULL,
	"tool_policy_version" varchar(160) NOT NULL,
	"context_policy_version" varchar(160) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_arms_experiment_name_unique" UNIQUE("experiment_id","name")
);--> statement-breakpoint
CREATE TABLE "eval_trials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"arm_id" uuid NOT NULL,
	"case_id" varchar(200) NOT NULL,
	"attempt" integer NOT NULL,
	"seed" varchar(160) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"result_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"process_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "eval_trials_arm_case_attempt_unique" UNIQUE("arm_id","case_id","attempt"),
	CONSTRAINT "eval_trials_attempt_check" CHECK ("eval_trials"."attempt" > 0),
	CONSTRAINT "eval_trials_status_check" CHECK ("eval_trials"."status" in ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
);--> statement-breakpoint
CREATE TABLE "eval_run_traces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trial_id" uuid NOT NULL,
	"redacted_trace" jsonb NOT NULL,
	"trace_hash" varchar(80) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_run_traces_trial_unique" UNIQUE("trial_id")
);--> statement-breakpoint
ALTER TABLE "eval_arms" ADD CONSTRAINT "eval_arms_experiment_id_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."eval_experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD CONSTRAINT "eval_trials_arm_id_eval_arms_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."eval_arms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD CONSTRAINT "eval_trials_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_traces" ADD CONSTRAINT "eval_run_traces_trial_id_eval_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."eval_trials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_trials_status_idx" ON "eval_trials" USING btree ("status","updated_at");
