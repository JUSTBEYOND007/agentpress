CREATE TABLE "agent_task_leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"lease_token" varchar(160) NOT NULL,
	"worker_id" varchar(160) NOT NULL,
	"acquired_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"released_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_task_leases_lease_token_unique" UNIQUE("lease_token"),
	CONSTRAINT "agent_task_leases_task_attempt_unique" UNIQUE("task_id", "attempt"),
	CONSTRAINT "agent_task_leases_attempt_check" CHECK ("attempt" > 0),
	CONSTRAINT "agent_task_leases_expiry_check" CHECK ("expires_at" > "acquired_at")
);
--> statement-breakpoint
ALTER TABLE "agent_task_leases" ADD CONSTRAINT "agent_task_leases_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_task_leases" ADD CONSTRAINT "agent_task_leases_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_task_leases_active_idx" ON "agent_task_leases" USING btree ("task_id", "expires_at", "released_at");
