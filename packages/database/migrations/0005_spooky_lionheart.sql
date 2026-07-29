CREATE TYPE "public"."media_asset_kind" AS ENUM('generated', 'licensed');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('published', 'unpublished');--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"approved_tool_call_id" uuid,
	"kind" "media_asset_kind" NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"byte_size" bigint NOT NULL,
	"checksum" varchar(80) NOT NULL,
	"width" integer,
	"height" integer,
	"source_url" text,
	"license" varchar(160),
	"attribution" text,
	"prompt" text,
	"model" varchar(200),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "media_assets_size_check" CHECK ("media_assets"."byte_size" > 0),
	CONSTRAINT "media_assets_provenance_check" CHECK (("media_assets"."kind" = 'generated' and "media_assets"."prompt" is not null and "media_assets"."model" is not null)
          or ("media_assets"."kind" = 'licensed' and "media_assets"."source_url" is not null and "media_assets"."license" is not null and "media_assets"."attribution" is not null))
);
--> statement-breakpoint
CREATE TABLE "publication_editions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" uuid NOT NULL,
	"article_revision_id" uuid NOT NULL,
	"edition_number" integer NOT NULL,
	"title_snapshot" text NOT NULL,
	"document_snapshot" jsonb NOT NULL,
	"cover_asset_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_editions_article_number_unique" UNIQUE("article_id","edition_number"),
	CONSTRAINT "publication_editions_number_check" CHECK ("publication_editions"."edition_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "publication_rankings" (
	"publication_id" uuid PRIMARY KEY NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_rankings_counts_check" CHECK ("publication_rankings"."upvotes" >= 0 and "publication_rankings"."downvotes" >= 0 and "publication_rankings"."views" >= 0)
);
--> statement-breakpoint
CREATE TABLE "publication_reactions" (
	"publication_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reaction" varchar(12) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_reactions_publication_id_user_id_pk" PRIMARY KEY("publication_id","user_id"),
	CONSTRAINT "publication_reactions_value_check" CHECK ("publication_reactions"."reaction" in ('up', 'down'))
);
--> statement-breakpoint
CREATE TABLE "publication_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"publication_id" uuid NOT NULL,
	"viewer_hash" varchar(80) NOT NULL,
	"window_started_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_views_dedupe_unique" UNIQUE("publication_id","viewer_hash","window_started_at")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"edition_id" uuid NOT NULL,
	"slug" varchar(180) NOT NULL,
	"status" "publication_status" DEFAULT 'published' NOT NULL,
	"published_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_slug_unique" UNIQUE("slug"),
	CONSTRAINT "publications_edition_unique" UNIQUE("edition_id")
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_approved_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("approved_tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_editions" ADD CONSTRAINT "publication_editions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_editions" ADD CONSTRAINT "publication_editions_article_revision_id_article_revisions_id_fk" FOREIGN KEY ("article_revision_id") REFERENCES "public"."article_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_editions" ADD CONSTRAINT "publication_editions_cover_asset_id_media_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_editions" ADD CONSTRAINT "publication_editions_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_rankings" ADD CONSTRAINT "publication_rankings_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_reactions" ADD CONSTRAINT "publication_reactions_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_reactions" ADD CONSTRAINT "publication_reactions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_views" ADD CONSTRAINT "publication_views_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_edition_id_publication_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."publication_editions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_workspace_created_idx" ON "media_assets" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "publication_rankings_score_idx" ON "publication_rankings" USING btree ("score","updated_at");--> statement-breakpoint
CREATE INDEX "publication_views_publication_created_idx" ON "publication_views" USING btree ("publication_id","created_at");--> statement-breakpoint
CREATE INDEX "publications_status_published_idx" ON "publications" USING btree ("status","published_at");