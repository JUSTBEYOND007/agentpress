CREATE TABLE "content_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" varchar(180) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "content_folders_parent_name_unique" UNIQUE("workspace_id","parent_id","name"),
	CONSTRAINT "content_folders_position_check" CHECK ("content_folders"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "deleted_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "content_folders" ADD CONSTRAINT "content_folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_folders" ADD CONSTRAINT "content_folders_parent_id_content_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."content_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_folders_workspace_parent_idx" ON "content_folders" USING btree ("workspace_id","parent_id");--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_folder_id_content_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."content_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "articles_folder_updated_idx" ON "articles" USING btree ("folder_id","updated_at");