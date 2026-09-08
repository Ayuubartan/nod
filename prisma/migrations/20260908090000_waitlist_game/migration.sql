-- The waitlist as a game (docs/13): points, levels, verification, events, SMS consent.
-- CreateEnum
CREATE TYPE "WaitlistEventType" AS ENUM ('SIGNED_UP', 'EMAIL_VERIFIED', 'PHONE_VERIFIED', 'PROFILE_COMPLETED', 'FRIEND_JOINED', 'FRIEND_VERIFIED', 'RANK_CHANGED', 'LEVEL_UNLOCKED', 'REWARD_UNLOCKED', 'ACCESS_GRANTED', 'ACCESS_USED');

-- AlterTable
ALTER TABLE "WaitlistEntry" ADD COLUMN     "accessExpiresAt" TIMESTAMP(3),
ADD COLUMN     "accessGrantedAt" TIMESTAMP(3),
ADD COLUMN     "convertedUserId" TEXT,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "ipHash" TEXT,
ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "lastNotifiedRank" INTEGER,
ADD COLUMN     "lastSmsAt" TIMESTAMP(3),
ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "marketingConsentAt" TIMESTAMP(3),
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "points" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priorityAt" TIMESTAMP(3),
ADD COLUMN     "signupSource" TEXT,
ADD COLUMN     "smsConsentAt" TIMESTAMP(3),
ADD COLUMN     "smsOptOutAt" TIMESTAMP(3),
ADD COLUMN     "utmCampaign" TEXT,
ADD COLUMN     "utmMedium" TEXT,
ADD COLUMN     "utmSource" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedReferrals" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "handle" DROP NOT NULL,
ALTER COLUMN "platform" DROP NOT NULL,
ALTER COLUMN "ageBracket" DROP NOT NULL,
ALTER COLUMN "followersBracket" DROP NOT NULL;

-- CreateTable
CREATE TABLE "WaitlistPoint" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEvent" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "type" "WaitlistEventType" NOT NULL,
    "data" JSONB,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaitlistPoint_entryId_idx" ON "WaitlistPoint"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistPoint_entryId_reason_refId_key" ON "WaitlistPoint"("entryId", "reason", "refId");

-- CreateIndex
CREATE INDEX "WaitlistEvent_entryId_createdAt_idx" ON "WaitlistEvent"("entryId", "createdAt");

-- CreateIndex
CREATE INDEX "WaitlistEvent_notifiedAt_createdAt_idx" ON "WaitlistEvent"("notifiedAt", "createdAt");

-- CreateIndex
CREATE INDEX "PhoneCode_phone_createdAt_idx" ON "PhoneCode"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "WaitlistEntry_phone_idx" ON "WaitlistEntry"("phone");

-- CreateIndex
CREATE INDEX "WaitlistEntry_ipHash_idx" ON "WaitlistEntry"("ipHash");

-- CreateIndex
CREATE INDEX "WaitlistEntry_points_createdAt_idx" ON "WaitlistEntry"("points" DESC, "createdAt");

-- CreateIndex
CREATE INDEX "WaitlistEntry_city_verifiedAt_idx" ON "WaitlistEntry"("city", "verifiedAt");

-- AddForeignKey
ALTER TABLE "WaitlistPoint" ADD CONSTRAINT "WaitlistPoint_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "WaitlistEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEvent" ADD CONSTRAINT "WaitlistEvent_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "WaitlistEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Existing rows already told us their email; the confirmation mail is what verifies it
-- from now on, so they keep parity with nothing extra to do.
UPDATE "WaitlistEntry" SET "emailVerifiedAt" = "createdAt", "verifiedAt" = "createdAt" WHERE "deletedAt" IS NULL;

-- Server-side only, like every other table (see 20260907120000_rls).
ALTER TABLE "WaitlistPoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WaitlistEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PhoneCode" ENABLE ROW LEVEL SECURITY;
