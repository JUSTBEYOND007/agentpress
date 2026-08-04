CREATE TABLE "run_tool_choices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"choice" jsonb NOT NULL,
	"label" varchar(160) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"rejection_reason" varchar(32),
	"claim_token" uuid,
	"recovery_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp (3) with time zone,
	"settled_at" timestamp (3) with time zone,
	CONSTRAINT "run_tool_choices_run_sequence_unique" UNIQUE("run_id", "sequence"),
	CONSTRAINT "run_tool_choices_status_check" CHECK ("run_tool_choices"."status" in ('pending', 'in_flight', 'resolved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "run_tool_choices" ADD CONSTRAINT "run_tool_choices_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "run_tool_choices_run_status_idx" ON "run_tool_choices" USING btree ("run_id", "status", "sequence");
