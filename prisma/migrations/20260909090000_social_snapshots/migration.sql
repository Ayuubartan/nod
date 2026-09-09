-- Social account analytics history (docs/04 SocialAccountSnapshot, docs/06 sections 1-2).
-- CreateTable
CREATE TABLE "SocialAccountSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "followers" INTEGER NOT NULL,
    "avgViews30d" INTEGER NOT NULL,
    "posts30d" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SocialAccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialAccountSnapshot_accountId_capturedAt_idx" ON "SocialAccountSnapshot"("accountId", "capturedAt");

-- AddForeignKey
ALTER TABLE "SocialAccountSnapshot" ADD CONSTRAINT "SocialAccountSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS, same shape as ViewSnapshot (20260907120000_rls): ops reads everything, a
-- participant reads the history of their own accounts, writes stay with the service role.
ALTER TABLE "SocialAccountSnapshot" ENABLE ROW LEVEL SECURITY;

CREATE POLICY ops_read_all ON "SocialAccountSnapshot" FOR SELECT USING (nod_is_ops());

CREATE POLICY own_account_snapshots ON "SocialAccountSnapshot"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "SocialAccount" a
      WHERE a.id = "SocialAccountSnapshot"."accountId" AND a."userId" = nod_user_id()
    )
  );
