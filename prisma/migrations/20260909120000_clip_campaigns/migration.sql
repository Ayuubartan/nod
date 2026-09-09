-- Clip campaigns (docs/14): campaign kind + clip rules, memberships, submissions, snapshots.
-- CreateEnum
CREATE TYPE "CampaignKind" AS ENUM ('PLACEMENT', 'CLIP');

-- CreateEnum
CREATE TYPE "MembershipState" AS ENUM ('JOINED', 'LEFT', 'SUSPENDED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SubmissionState" AS ENUM ('RECEIVED', 'FIX_DISCLOSURE', 'TRACKING', 'VALIDATING', 'HELD', 'QUALIFIED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "SubmissionRejectReason" AS ENUM ('NOT_OWNER', 'NOT_FOUND', 'OUTSIDE_WINDOW', 'NO_DISCLOSURE', 'DELETED_EARLY', 'FRAUD', 'OPS_REJECTED', 'DUPLICATE');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "joinCap" INTEGER,
ADD COLUMN     "joinsPausedAt" TIMESTAMP(3),
ADD COLUMN     "kind" "CampaignKind" NOT NULL DEFAULT 'PLACEMENT',
ADD COLUMN     "platforms" "AccountPlatform"[] DEFAULT ARRAY['INSTAGRAM', 'TIKTOK']::"AccountPlatform"[],
ADD COLUMN     "requiredHashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "requiredMentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "submissionsPausedAt" TIMESTAMP(3),
ADD COLUMN     "validationHours" INTEGER NOT NULL DEFAULT 168;

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "submissionId" TEXT;

-- CreateTable
CREATE TABLE "CampaignMembership" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "MembershipState" NOT NULL DEFAULT 'JOINED',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" "AccountPlatform" NOT NULL,
    "state" "SubmissionState" NOT NULL DEFAULT 'RECEIVED',
    "rejectReason" "SubmissionRejectReason",
    "rejectNote" TEXT,
    "postId" TEXT NOT NULL,
    "providerMediaId" TEXT,
    "canonicalUrl" TEXT NOT NULL,
    "caption" TEXT,
    "publishedAt" TIMESTAMP(3),
    "initialViews" INTEGER NOT NULL DEFAULT 0,
    "latestViews" INTEGER NOT NULL DEFAULT 0,
    "eligibleViews" INTEGER NOT NULL DEFAULT 0,
    "latestLikes" INTEGER NOT NULL DEFAULT 0,
    "latestComments" INTEGER NOT NULL DEFAULT 0,
    "latestShares" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "reservationOre" INTEGER NOT NULL DEFAULT 0,
    "budgetExhausted" BOOLEAN NOT NULL DEFAULT false,
    "nextCheckAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveMissing" INTEGER NOT NULL DEFAULT 0,
    "trackingPausedAt" TIMESTAMP(3),
    "riskScore" INTEGER,
    "riskFactors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fixWindowEndsAt" TIMESTAMP(3),
    "validationEndsAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionSnapshot" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bucket" INTEGER NOT NULL,
    "views" INTEGER NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SubmissionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignMembership_userId_state_idx" ON "CampaignMembership"("userId", "state");

-- CreateIndex
CREATE INDEX "CampaignMembership_campaignId_state_idx" ON "CampaignMembership"("campaignId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMembership_campaignId_userId_key" ON "CampaignMembership"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "Submission_campaignId_state_idx" ON "Submission"("campaignId", "state");

-- CreateIndex
CREATE INDEX "Submission_userId_state_idx" ON "Submission"("userId", "state");

-- CreateIndex
CREATE INDEX "Submission_state_nextCheckAt_idx" ON "Submission"("state", "nextCheckAt");

-- CreateIndex
CREATE INDEX "Submission_state_validationEndsAt_idx" ON "Submission"("state", "validationEndsAt");

-- CreateIndex
CREATE INDEX "Submission_state_fixWindowEndsAt_idx" ON "Submission"("state", "fixWindowEndsAt");

-- CreateIndex
CREATE INDEX "Submission_socialAccountId_idx" ON "Submission"("socialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_campaignId_platform_postId_key" ON "Submission"("campaignId", "platform", "postId");

-- CreateIndex
CREATE INDEX "SubmissionSnapshot_submissionId_observedAt_idx" ON "SubmissionSnapshot"("submissionId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionSnapshot_submissionId_bucket_key" ON "SubmissionSnapshot"("submissionId", "bucket");

-- CreateIndex
CREATE INDEX "Campaign_kind_state_idx" ON "Campaign"("kind", "state");

-- CreateIndex
CREATE INDEX "LedgerEntry_submissionId_idx" ON "LedgerEntry"("submissionId");

-- AddForeignKey
ALTER TABLE "CampaignMembership" ADD CONSTRAINT "CampaignMembership_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMembership" ADD CONSTRAINT "CampaignMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "CampaignMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionSnapshot" ADD CONSTRAINT "SubmissionSnapshot_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- RLS, same shape as Placement (20260907120000_rls): ops reads everything, a participant
-- reads their own rows, a brand reads the rows of its own campaigns. Writes stay with the
-- service role.
ALTER TABLE "CampaignMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Submission"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubmissionSnapshot" ENABLE ROW LEVEL SECURITY;

CREATE POLICY ops_read_all ON "CampaignMembership" FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Submission"         FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "SubmissionSnapshot" FOR SELECT USING (nod_is_ops());

CREATE POLICY own_memberships ON "CampaignMembership"
  FOR SELECT USING ("userId" = nod_user_id());

CREATE POLICY own_submissions ON "Submission"
  FOR SELECT USING ("userId" = nod_user_id());

CREATE POLICY own_submission_snapshots ON "SubmissionSnapshot"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Submission" s WHERE s.id = "submissionId" AND s."userId" = nod_user_id())
  );

CREATE POLICY own_campaign_memberships ON "CampaignMembership"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Campaign" c WHERE c.id = "campaignId" AND c."brandId" = nod_brand_id())
  );

CREATE POLICY own_campaign_submissions ON "Submission"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Campaign" c WHERE c.id = "campaignId" AND c."brandId" = nod_brand_id())
  );
