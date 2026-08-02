CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(80) NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"token_count" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_document_ordinal_unique" UNIQUE("document_id","ordinal"),
	CONSTRAINT "knowledge_chunks_ordinal_check" CHECK ("knowledge_chunks"."ordinal" >= 0),
	CONSTRAINT "knowledge_chunks_token_count_check" CHECK ("knowledge_chunks"."token_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_uri" text NOT NULL,
	"title" text NOT NULL,
	"revision_hash" varchar(80) NOT NULL,
	"acl" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_source_revision_unique" UNIQUE("workspace_id","source_uri","revision_hash")
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_fts_idx" ON "knowledge_chunks" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_documents_workspace_idx" ON "knowledge_documents" USING btree ("workspace_id","updated_at");
