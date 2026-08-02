ALTER TABLE "conversations" ADD COLUMN "article_id" uuid;--> statement-breakpoint
UPDATE "conversations"
SET "article_id" = substring("title" from 9)::uuid
WHERE "title" ~ '^article:[0-9a-fA-F-]{36}$'
  AND EXISTS (
    SELECT 1
    FROM "articles"
    WHERE "articles"."id" = substring("conversations"."title" from 9)::uuid
  );--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_article_unique" UNIQUE("article_id");
