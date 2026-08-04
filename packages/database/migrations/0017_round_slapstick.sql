CREATE TABLE "edit_proposal_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_tool_call_id" uuid NOT NULL,
	"batch_number" integer NOT NULL,
	"operations" jsonb NOT NULL,
	"diffs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"before_hash" varchar(80) NOT NULL,
	"after_hash" varchar(80) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edit_proposal_batches_proposal_number_unique" UNIQUE("proposal_id","batch_number"),
	CONSTRAINT "edit_proposal_batches_source_tool_call_unique" UNIQUE("source_tool_call_id"),
	CONSTRAINT "edit_proposal_batches_number_check" CHECK ("edit_proposal_batches"."batch_number" > 0),
	CONSTRAINT "edit_proposal_batches_status_check" CHECK ("edit_proposal_batches"."status" in ('active', 'reverted'))
);
--> statement-breakpoint
ALTER TABLE "edit_proposal_batches" ADD CONSTRAINT "edit_proposal_batches_proposal_id_edit_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."edit_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposal_batches" ADD CONSTRAINT "edit_proposal_batches_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposal_batches" ADD CONSTRAINT "edit_proposal_batches_source_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("source_tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edit_proposal_batches_proposal_idx" ON "edit_proposal_batches" USING btree ("proposal_id","batch_number");