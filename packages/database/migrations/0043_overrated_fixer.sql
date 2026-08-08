CREATE TABLE "run_specialist_budgets" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"max_tokens" integer NOT NULL,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"consumed_tokens" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_specialist_budgets_max_check" CHECK ("run_specialist_budgets"."max_tokens" > 0),
	CONSTRAINT "run_specialist_budgets_totals_check" CHECK ("run_specialist_budgets"."reserved_tokens" >= 0 and "run_specialist_budgets"."consumed_tokens" >= 0),
	CONSTRAINT "run_specialist_budgets_version_check" CHECK ("run_specialist_budgets"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "task_budget_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"reserved_tokens" integer NOT NULL,
	"actual_tokens" integer,
	"status" varchar(24) NOT NULL,
	"settled_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_budget_reservations_task_attempt_unique" UNIQUE("task_id","attempt"),
	CONSTRAINT "task_budget_reservations_attempt_check" CHECK ("task_budget_reservations"."attempt" > 0),
	CONSTRAINT "task_budget_reservations_reserved_check" CHECK ("task_budget_reservations"."reserved_tokens" > 0),
	CONSTRAINT "task_budget_reservations_actual_check" CHECK ("task_budget_reservations"."actual_tokens" is null or "task_budget_reservations"."actual_tokens" >= 0),
	CONSTRAINT "task_budget_reservations_status_check" CHECK ("task_budget_reservations"."status" in ('active', 'settled', 'forfeited')),
	CONSTRAINT "task_budget_reservations_settlement_check" CHECK (("task_budget_reservations"."status" = 'active' and "task_budget_reservations"."actual_tokens" is null and "task_budget_reservations"."settled_at" is null)
        or ("task_budget_reservations"."status" in ('settled', 'forfeited') and "task_budget_reservations"."actual_tokens" is not null and "task_budget_reservations"."settled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "run_specialist_budgets" ADD CONSTRAINT "run_specialist_budgets_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_budget_reservations" ADD CONSTRAINT "task_budget_reservations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_budget_reservations" ADD CONSTRAINT "task_budget_reservations_plan_revision_id_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_budget_reservations" ADD CONSTRAINT "task_budget_reservations_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_budget_reservations_run_status_idx" ON "task_budget_reservations" USING btree ("run_id","status");
--> statement-breakpoint
INSERT INTO "run_specialist_budgets" ("run_id", "max_tokens")
SELECT "id", 96000 FROM "agent_runs"
ON CONFLICT ("run_id") DO NOTHING;
