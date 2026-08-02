DROP INDEX IF EXISTS "knowledge_chunks_embedding_hnsw_idx";
--> statement-breakpoint
DELETE FROM "knowledge_documents";
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" SET DATA TYPE vector(1024);
--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);
