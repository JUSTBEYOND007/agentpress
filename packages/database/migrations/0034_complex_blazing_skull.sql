ALTER TABLE "prompt_revisions" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "prompt_revisions" ADD COLUMN "snapshot_hash" varchar(80);--> statement-breakpoint
UPDATE "prompt_revisions"
SET
  "snapshot" = jsonb_build_object(
    'schemaVersion', 1,
    'templateVersion', "version",
    'variableSchemaVersion', 'none',
    'renderedContentHash', "content_hash",
    'blocks', jsonb_build_array(
      jsonb_build_object('id', "prompt_id" || '.rendered', 'contentHash', "content_hash")
    )
  ),
  "snapshot_hash" = "content_hash";--> statement-breakpoint
ALTER TABLE "prompt_revisions" ALTER COLUMN "snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_revisions" ALTER COLUMN "snapshot_hash" SET NOT NULL;
