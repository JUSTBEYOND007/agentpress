CREATE TABLE "run_context_packs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"prompt_revision_id" uuid NOT NULL,
	"manifest" jsonb NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"token_count" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_context_packs_run_unique" UNIQUE("run_id"),
	CONSTRAINT "run_context_packs_token_count_check" CHECK ("run_context_packs"."token_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_skill_bindings" (
	"run_id" uuid NOT NULL,
	"skill_revision_id" uuid NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"allowed_tools" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_skill_bindings_run_id_skill_revision_id_pk" PRIMARY KEY("run_id","skill_revision_id")
);
--> statement-breakpoint
ALTER TABLE "run_context_packs" ADD CONSTRAINT "run_context_packs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context_packs" ADD CONSTRAINT "run_context_packs_prompt_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("prompt_revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_skill_bindings" ADD CONSTRAINT "run_skill_bindings_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_skill_bindings" ADD CONSTRAINT "run_skill_bindings_skill_revision_id_skill_revisions_id_fk" FOREIGN KEY ("skill_revision_id") REFERENCES "public"."skill_revisions"("id") ON DELETE restrict ON UPDATE no action;