CREATE TABLE "conversation_read_states" (
	"user_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"last_read_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_read_states_user_id_branch_id_pk" PRIMARY KEY("user_id","branch_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_branch_id_conversation_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE cascade ON UPDATE no action;