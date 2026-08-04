ALTER TABLE "memory_candidates"
ADD COLUMN "source_memory_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
