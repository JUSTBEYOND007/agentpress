CREATE TABLE "task_result_invalidations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_result_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"reason" varchar(48) NOT NULL,
	"issues" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_result_invalidations_result_unique" UNIQUE("task_result_id"),
	CONSTRAINT "task_result_invalidations_reason_check" CHECK ("task_result_invalidations"."reason" in ('recovery_validation_failed'))
);
--> statement-breakpoint
ALTER TABLE "task_result_invalidations" ADD CONSTRAINT "task_result_invalidations_task_result_id_task_results_id_fk" FOREIGN KEY ("task_result_id") REFERENCES "public"."task_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_result_invalidations" ADD CONSTRAINT "task_result_invalidations_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_result_invalidations" ADD CONSTRAINT "task_result_invalidations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_result_invalidations_run_task_idx" ON "task_result_invalidations" USING btree ("run_id","task_id");