CREATE TABLE "skill_revision_resources" (
	"skill_revision_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_revision_resources_skill_revision_id_path_pk" PRIMARY KEY("skill_revision_id","path"),
	CONSTRAINT "skill_revision_resources_size_check" CHECK ("skill_revision_resources"."byte_size" > 0 and "skill_revision_resources"."byte_size" <= 256000)
);--> statement-breakpoint
ALTER TABLE "skill_revision_resources" ADD CONSTRAINT "skill_revision_resources_skill_revision_id_skill_revisions_id_fk" FOREIGN KEY ("skill_revision_id") REFERENCES "public"."skill_revisions"("id") ON DELETE cascade ON UPDATE no action;
