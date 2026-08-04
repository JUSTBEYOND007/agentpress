CREATE TABLE "agent_session_compactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"previous_compaction_id" uuid,
	"version" integer NOT NULL,
	"status" varchar(24) NOT NULL,
	"reason" varchar(24) NOT NULL,
	"source_from_entry_id" uuid NOT NULL,
	"source_from_sequence" bigint NOT NULL,
	"source_through_entry_id" uuid NOT NULL,
	"source_through_sequence" bigint NOT NULL,
	"first_kept_entry_id" uuid,
	"first_kept_sequence" bigint,
	"summary" text,
	"tokens_before" integer NOT NULL,
	"token_count" integer,
	"preserve_data" jsonb NOT NULL,
	"model" varchar(240) NOT NULL,
	"prompt_version" varchar(160) NOT NULL,
	"reserve_tokens" integer NOT NULL,
	"reserve_provenance" varchar(24) NOT NULL,
	"failure" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_compactions_session_version_unique" UNIQUE("session_id","version"),
	CONSTRAINT "agent_session_compactions_version_check" CHECK ("version" > 0),
	CONSTRAINT "agent_session_compactions_status_check" CHECK ("status" in ('completed', 'failed')),
	CONSTRAINT "agent_session_compactions_reason_check" CHECK ("reason" in ('mid_turn', 'overflow')),
	CONSTRAINT "agent_session_compactions_source_range_check" CHECK ("source_from_sequence" > 0 and "source_through_sequence" >= "source_from_sequence"),
	CONSTRAINT "agent_session_compactions_token_check" CHECK ("tokens_before" >= 0 and "reserve_tokens" >= 0 and ("token_count" is null or "token_count" >= 0)),
	CONSTRAINT "agent_session_compactions_reserve_provenance_check" CHECK ("reserve_provenance" in ('default', 'explicit', 'proportional')),
	CONSTRAINT "agent_session_compactions_result_check" CHECK ((
		"status" = 'completed'
		and length(trim("summary")) > 0
		and "first_kept_entry_id" is not null
		and "first_kept_sequence" > "source_through_sequence"
		and "token_count" is not null
		and "failure" is null
	) or (
		"status" = 'failed'
		and "summary" is null
		and "first_kept_entry_id" is null
		and "first_kept_sequence" is null
		and "token_count" is null
		and "failure" is not null
	))
);
--> statement-breakpoint
ALTER TABLE "agent_session_compactions" ADD CONSTRAINT "agent_session_compactions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_compactions" ADD CONSTRAINT "agent_session_compactions_previous_compaction_id_agent_session_compactions_id_fk" FOREIGN KEY ("previous_compaction_id") REFERENCES "public"."agent_session_compactions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_compactions" ADD CONSTRAINT "agent_session_compactions_source_from_entry_id_agent_transcript_entries_id_fk" FOREIGN KEY ("source_from_entry_id") REFERENCES "public"."agent_transcript_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_compactions" ADD CONSTRAINT "agent_session_compactions_source_through_entry_id_agent_transcript_entries_id_fk" FOREIGN KEY ("source_through_entry_id") REFERENCES "public"."agent_transcript_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_compactions" ADD CONSTRAINT "agent_session_compactions_first_kept_entry_id_agent_transcript_entries_id_fk" FOREIGN KEY ("first_kept_entry_id") REFERENCES "public"."agent_transcript_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_session_compactions_session_status_version_idx" ON "agent_session_compactions" USING btree ("session_id", "status", "version");
