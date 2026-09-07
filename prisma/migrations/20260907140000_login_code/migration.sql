-- Email one-time sign-in codes (lib/login.ts).
CREATE TYPE "LoginAudience" AS ENUM ('PARTICIPANT', 'BRAND');

CREATE TABLE "LoginCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "audience" "LoginAudience" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LoginCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginCode_email_audience_createdAt_idx" ON "LoginCode"("email", "audience", "createdAt");

-- Server-side only: no policy for anon/authenticated, so a leaked client key reads nothing.
ALTER TABLE "LoginCode" ENABLE ROW LEVEL SECURITY;
