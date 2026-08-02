ALTER TABLE "edit_proposals" ADD COLUMN "diffs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "source_tool_call_id" uuid;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_source_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("source_tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
WITH "ranked_pending" AS (
	SELECT "id", row_number() OVER (PARTITION BY "article_id" ORDER BY "created_at" DESC, "id" DESC) AS "rank"
	FROM "edit_proposals"
	WHERE "status" = 'pending'
)
UPDATE "edit_proposals"
SET "status" = 'expired', "updated_at" = now()
WHERE "id" IN (SELECT "id" FROM "ranked_pending" WHERE "rank" > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "edit_proposals_source_tool_call_unique" ON "edit_proposals" USING btree ("source_tool_call_id") WHERE "edit_proposals"."source_tool_call_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "edit_proposals_one_pending_article_unique" ON "edit_proposals" USING btree ("article_id") WHERE "edit_proposals"."status" = 'pending';
