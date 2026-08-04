ALTER TABLE "task_results" ADD COLUMN "summary" text;--> statement-breakpoint
UPDATE "task_results"
SET "summary" = COALESCE(
  NULLIF("failure" ->> 'message', ''),
  NULLIF("artifacts" -> 0 ->> 'summary', ''),
  CASE
    WHEN "status" = 'succeeded' THEN 'Previously completed task result'
    ELSE 'Previously failed task result'
  END
);--> statement-breakpoint
ALTER TABLE "task_results" ALTER COLUMN "summary" SET NOT NULL;
