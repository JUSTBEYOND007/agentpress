ALTER TABLE "memory_candidates" ADD COLUMN "source_run_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "source_tool_call_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_source_run_id_agent_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_source_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("source_tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_candidates_source_run_idx" ON "memory_candidates" USING btree ("source_run_id");