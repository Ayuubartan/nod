-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PARTICIPANT', 'BRAND', 'OPS');

-- CreateEnum
CREATE TYPE "ParticipantState" AS ENUM ('SIGNED_UP', 'ONBOARDED', 'VERIFIED', 'ACTIVE', 'FLAGGED', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "AccountPlatform" AS ENUM ('INSTAGRAM', 'TIKTOK');

-- CreateEnum
CREATE TYPE "AccountTier" AS ENUM ('CONNECTED_API', 'CONNECTED_SCREENSHOT', 'BELOW_FLOOR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "CampaignState" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED', 'AWAITING_FUNDS', 'FUNDED', 'LIVE', 'FILLING', 'EXHAUSTED', 'EXPIRED', 'PAUSED', 'RECONCILING', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReviewTier" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "PayoutKind" AS ENUM ('FIXED', 'CPM', 'HYBRID', 'HYBRID_BONUS');

-- CreateEnum
CREATE TYPE "PlacementState" AS ENUM ('CLAIMED', 'UPLOADED', 'POSITIONED', 'GENERATING', 'GENERATION_FAILED', 'PARTICIPANT_REVIEW', 'BRAND_REVIEW', 'APPROVED', 'PUBLISHED', 'VERIFYING', 'FLAGGED', 'QUALIFIED', 'PAID', 'REJECTED', 'EXPIRED', 'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND', 'DISPUTED');

-- CreateEnum
CREATE TYPE "RejectReason" AS ENUM ('NO_DISCLOSURE', 'MEDIA_MISMATCH', 'WRONG_ACCOUNT', 'DELETED_EARLY', 'FRAUD', 'BRAND_SAFETY', 'OTHER');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('DEPOSIT', 'RESERVE', 'RELEASE_RESERVATION', 'SETTLE', 'PAYOUT_ACCRUE', 'TAKE', 'PAYOUT_SENT', 'REFUND', 'ROLLOVER', 'CREDIT_TERMS_FEE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StrikeSeverity" AS ENUM ('MINOR', 'SERIOUS');

-- CreateEnum
CREATE TYPE "DisputeState" AS ENUM ('OPEN', 'UPHELD', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayoutBatchState" AS ENUM ('OPEN', 'EXPORTED', 'SETTLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "email" TEXT,
    "role" "Role" NOT NULL DEFAULT 'PARTICIPANT',
    "state" "ParticipantState" NOT NULL DEFAULT 'SIGNED_UP',
    "locale" TEXT NOT NULL DEFAULT 'sv',
    "city" TEXT,
    "ageBracket" TEXT,
    "swishNumber" TEXT,
    "trainingConsent" BOOLEAN NOT NULL DEFAULT false,
    "disclosureQuizAt" TIMESTAMP(3),
    "termsAcceptedAt" TIMESTAMP(3),
    "pushSubscription" JSONB,
    "smsOptIn" BOOLEAN NOT NULL DEFAULT false,
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "reputation" INTEGER NOT NULL DEFAULT 0,
    "onboardingStep" INTEGER NOT NULL DEFAULT 1,
    "deletionRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "birthYear" INTEGER NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "AccountPlatform" NOT NULL,
    "handle" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "tier" "AccountTier" NOT NULL,
    "accountType" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "followers" INTEGER NOT NULL DEFAULT 0,
    "avgViews30d" INTEGER NOT NULL DEFAULT 0,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "severity" "StrikeSeverity" NOT NULL,
    "reason" TEXT NOT NULL,
    "placementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Strike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "firstPlacementAt" TIMESTAMP(3),
    "bonusPaidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orgNumber" TEXT,
    "stripeCustomerId" TEXT,
    "invoiceWhitelisted" BOOLEAN NOT NULL DEFAULT false,
    "rolloverPreference" TEXT NOT NULL DEFAULT 'refund',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandUser" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BrandUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" "CampaignState" NOT NULL DEFAULT 'DRAFT',
    "objective" TEXT NOT NULL DEFAULT 'awareness',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "goLiveAt" TIMESTAMP(3),
    "countries" TEXT[] DEFAULT ARRAY['SE']::TEXT[],
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ageBrackets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minFollowers" INTEGER NOT NULL DEFAULT 300,
    "maxFollowers" INTEGER,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rulesText" TEXT,
    "brandSafety" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewTier" "ReviewTier" NOT NULL DEFAULT 'B',
    "disclosureText" TEXT NOT NULL DEFAULT 'Reklam – i samarbete med {brand}',
    "perPersonCap" INTEGER NOT NULL DEFAULT 2,
    "budget" INTEGER NOT NULL DEFAULT 0,
    "perPlacementMax" INTEGER NOT NULL DEFAULT 50000,
    "fundedVia" TEXT,
    "creditTermsFeeBps" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "returnedNotes" TEXT,
    "fundedAt" TIMESTAMP(3),
    "liveAt" TIMESTAMP(3),
    "exhaustedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "reconcilingAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "disputeWindowEndsAt" TIMESTAMP(3),
    "stripeSessionId" TEXT,
    "reportPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutTemplate" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "PayoutKind" NOT NULL,
    "fixedOre" INTEGER NOT NULL DEFAULT 0,
    "cpmOre" INTEGER NOT NULL DEFAULT 0,
    "bonusAtViews" INTEGER,
    "bonusOre" INTEGER,
    "viewFloor" INTEGER NOT NULL DEFAULT 100,
    "takeRateBps" INTEGER NOT NULL DEFAULT 2800,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PayoutTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAsset" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "placementTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Placement" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "state" "PlacementState" NOT NULL DEFAULT 'CLAIMED',
    "rejectReason" "RejectReason",
    "rejectNote" TEXT,
    "reservationOre" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "clockPausedAt" TIMESTAMP(3),
    "pausedMs" INTEGER NOT NULL DEFAULT 0,
    "contentType" TEXT,
    "originalPath" TEXT,
    "originalHash" TEXT,
    "regionJson" JSONB,
    "assetId" TEXT,
    "regenCount" INTEGER NOT NULL DEFAULT 0,
    "currentVersionId" TEXT,
    "postUrl" TEXT,
    "postPlatformId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "holdEndsAt" TIMESTAMP(3),
    "disclosureTextIssued" TEXT,
    "disclosureToken" TEXT,
    "fixWindowEndsAt" TIMESTAMP(3),
    "brandSampled" BOOLEAN NOT NULL DEFAULT false,
    "settledAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Placement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlacementVersion" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "params" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PlacementVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlacementEvent" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PlacementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "accountMatch" BOOLEAN,
    "disclosureOk" BOOLEAN,
    "labelOk" BOOLEAN,
    "mediaMatch" DOUBLE PRECISION,
    "views" INTEGER,
    "viewsSource" TEXT,
    "screenshotPath" TEXT,
    "fraudScore" DOUBLE PRECISION,
    "fraudFactors" JSONB,
    "geoFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "qualifiedViews" INTEGER,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ViewSnapshot" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER NOT NULL,
    "reach" INTEGER,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ViewSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "state" "DisputeState" NOT NULL DEFAULT 'OPEN',
    "raisedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amountOre" INTEGER NOT NULL,
    "campaignId" TEXT,
    "walletId" TEXT,
    "placementId" TEXT,
    "batchId" TEXT,
    "memo" TEXT,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutBatch" (
    "id" TEXT NOT NULL,
    "state" "PayoutBatchState" NOT NULL DEFAULT 'OPEN',
    "exportedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "totalOre" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PayoutBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "platform" "AccountPlatform" NOT NULL,
    "city" TEXT NOT NULL,
    "ageBracket" TEXT NOT NULL,
    "followersBracket" TEXT NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "referredBy" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandEnquiry" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "budgetBracket" TEXT NOT NULL,
    "objective" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BrandEnquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "event" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flag" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_authId_key" ON "User"("authId");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_state_idx" ON "User"("state");

-- CreateIndex
CREATE INDEX "User_referredById_idx" ON "User"("referredById");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_userId_key" ON "Identity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_subjectHash_key" ON "Identity"("subjectHash");

-- CreateIndex
CREATE INDEX "SocialAccount_userId_idx" ON "SocialAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_platform_platformUserId_key" ON "SocialAccount"("platform", "platformUserId");

-- CreateIndex
CREATE INDEX "Strike_userId_idx" ON "Strike"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referredId_key" ON "Referral"("referredId");

-- CreateIndex
CREATE INDEX "Referral_referrerId_idx" ON "Referral"("referrerId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandUser_authId_key" ON "BrandUser"("authId");

-- CreateIndex
CREATE INDEX "BrandUser_brandId_idx" ON "BrandUser"("brandId");

-- CreateIndex
CREATE INDEX "Campaign_brandId_state_idx" ON "Campaign"("brandId", "state");

-- CreateIndex
CREATE INDEX "Campaign_state_goLiveAt_idx" ON "Campaign"("state", "goLiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutTemplate_campaignId_key" ON "PayoutTemplate"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignAsset_campaignId_idx" ON "CampaignAsset"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "Placement_disclosureToken_key" ON "Placement"("disclosureToken");

-- CreateIndex
CREATE INDEX "Placement_campaignId_state_idx" ON "Placement"("campaignId", "state");

-- CreateIndex
CREATE INDEX "Placement_userId_state_idx" ON "Placement"("userId", "state");

-- CreateIndex
CREATE INDEX "Placement_deadlineAt_idx" ON "Placement"("deadlineAt");

-- CreateIndex
CREATE INDEX "Placement_holdEndsAt_idx" ON "Placement"("holdEndsAt");

-- CreateIndex
CREATE INDEX "Placement_originalHash_idx" ON "Placement"("originalHash");

-- CreateIndex
CREATE INDEX "PlacementVersion_placementId_idx" ON "PlacementVersion"("placementId");

-- CreateIndex
CREATE INDEX "PlacementEvent_placementId_type_idx" ON "PlacementEvent"("placementId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Verification_placementId_key" ON "Verification"("placementId");

-- CreateIndex
CREATE INDEX "ViewSnapshot_verificationId_idx" ON "ViewSnapshot"("verificationId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_placementId_key" ON "Dispute"("placementId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_externalRef_key" ON "LedgerEntry"("externalRef");

-- CreateIndex
CREATE INDEX "LedgerEntry_campaignId_type_idx" ON "LedgerEntry"("campaignId", "type");

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_type_idx" ON "LedgerEntry"("walletId", "type");

-- CreateIndex
CREATE INDEX "LedgerEntry_placementId_idx" ON "LedgerEntry"("placementId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_referralCode_key" ON "WaitlistEntry"("referralCode");

-- CreateIndex
CREATE INDEX "WaitlistEntry_email_idx" ON "WaitlistEntry"("email");

-- CreateIndex
CREATE INDEX "WaitlistEntry_referredBy_idx" ON "WaitlistEntry"("referredBy");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_scope_idx" ON "IdempotencyKey"("scope");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strike" ADD CONSTRAINT "Strike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandUser" ADD CONSTRAINT "BrandUser_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutTemplate" ADD CONSTRAINT "PayoutTemplate_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAsset" ADD CONSTRAINT "CampaignAsset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementVersion" ADD CONSTRAINT "PlacementVersion_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "Placement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementEvent" ADD CONSTRAINT "PlacementEvent_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "Placement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "Placement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ViewSnapshot" ADD CONSTRAINT "ViewSnapshot_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "Verification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "Placement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

