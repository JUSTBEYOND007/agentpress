ALTER TABLE "evidence_records" ADD COLUMN "source_tool_call_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_source_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("source_tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_records_tool_source_unique" ON "evidence_records" USING btree ("source_tool_call_id","source_uri","content_hash");
