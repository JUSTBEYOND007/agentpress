CREATE TABLE "conversation_compactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"previous_compaction_id" uuid,
	"version" integer NOT NULL,
	"status" varchar(24) NOT NULL,
	"reason" varchar(24) NOT NULL,
	"source_from_message_id" uuid NOT NULL,
	"source_from_sequence" bigint NOT NULL,
	"source_through_message_id" uuid NOT NULL,
	"source_through_sequence" bigint NOT NULL,
	"first_kept_message_id" uuid,
	"first_kept_message_sequence" bigint,
	"summary" text,
	"short_summary" text,
	"tokens_before" integer NOT NULL,
	"token_count" integer,
	"preserve_data" jsonb NOT NULL,
	"model" varchar(240) NOT NULL,
	"prompt_version" varchar(160) NOT NULL,
	"reserve_tokens" integer NOT NULL,
	"reserve_provenance" varchar(24) NOT NULL,
	"failure" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_compactions_branch_version_unique" UNIQUE("branch_id","version"),
	CONSTRAINT "conversation_compactions_version_check" CHECK ("conversation_compactions"."version" > 0),
	CONSTRAINT "conversation_compactions_status_check" CHECK ("conversation_compactions"."status" in ('completed', 'failed')),
	CONSTRAINT "conversation_compactions_reason_check" CHECK ("conversation_compactions"."reason" in ('automatic', 'manual', 'mid_turn')),
	CONSTRAINT "conversation_compactions_source_range_check" CHECK ("conversation_compactions"."source_from_sequence" > 0 and "conversation_compactions"."source_through_sequence" >= "conversation_compactions"."source_from_sequence"),
	CONSTRAINT "conversation_compactions_token_check" CHECK ("conversation_compactions"."tokens_before" >= 0 and "conversation_compactions"."reserve_tokens" >= 0 and ("conversation_compactions"."token_count" is null or "conversation_compactions"."token_count" >= 0)),
	CONSTRAINT "conversation_compactions_reserve_provenance_check" CHECK ("conversation_compactions"."reserve_provenance" in ('default', 'explicit', 'proportional')),
	CONSTRAINT "conversation_compactions_result_check" CHECK ((
        "conversation_compactions"."status" = 'completed'
        and length(trim("conversation_compactions"."summary")) > 0
        and "conversation_compactions"."first_kept_message_id" is not null
        and "conversation_compactions"."first_kept_message_sequence" > "conversation_compactions"."source_through_sequence"
        and "conversation_compactions"."token_count" is not null
        and "conversation_compactions"."failure" is null
      ) or (
        "conversation_compactions"."status" = 'failed'
        and "conversation_compactions"."summary" is null
        and "conversation_compactions"."short_summary" is null
        and "conversation_compactions"."first_kept_message_id" is null
        and "conversation_compactions"."first_kept_message_sequence" is null
        and "conversation_compactions"."token_count" is null
        and "conversation_compactions"."failure" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_branch_id_conversation_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_previous_compaction_id_conversation_compactions_id_fk" FOREIGN KEY ("previous_compaction_id") REFERENCES "public"."conversation_compactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_source_from_message_id_conversation_messages_id_fk" FOREIGN KEY ("source_from_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_source_through_message_id_conversation_messages_id_fk" FOREIGN KEY ("source_through_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_first_kept_message_id_conversation_messages_id_fk" FOREIGN KEY ("first_kept_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_compactions_branch_status_version_idx" ON "conversation_compactions" USING btree ("branch_id","status","version");