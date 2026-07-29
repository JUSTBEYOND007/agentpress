CREATE TABLE "run_directives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"kind" varchar(24) NOT NULL,
	"content" text NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp (3) with time zone,
	CONSTRAINT "run_directives_run_sequence_unique" UNIQUE("run_id","sequence"),
	CONSTRAINT "run_directives_kind_check" CHECK ("run_directives"."kind" in ('steering', 'follow_up')),
	CONSTRAINT "run_directives_status_check" CHECK ("run_directives"."status" in ('pending', 'applied', 'consumed'))
);
--> statement-breakpoint
ALTER TABLE "run_directives" ADD CONSTRAINT "run_directives_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_directives_run_status_idx" ON "run_directives" USING btree ("run_id","status","sequence");