ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_type_check";
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_type_check" CHECK ("artifacts"."type" in ('ResearchBrief', 'Outline', 'ArticleDraft', 'EditProposal', 'ClaimReview', 'ImagePlan', 'AssetProposal', 'ToolOutput'));
