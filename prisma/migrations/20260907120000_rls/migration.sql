-- Row Level Security — docs/08 security baseline:
-- "RLS on all participant/brand tables; ops bypass via service role in server code only"
--
-- How this fits together:
--
--   NOD's application code connects as the database owner and does its own
--   authorisation (requireParticipant / requireBrandUser / requireOps). RLS is the
--   second line: it makes a Supabase anon or authenticated JWT — the credential that
--   would leak if a client-side key were ever exposed — unable to read anyone else's
--   money, media or identity, whatever the application layer does.
--
--   So the owner role keeps BYPASSRLS (that is Postgres' default for a table owner),
--   the service role bypasses by design, and `anon` / `authenticated` get exactly the
--   rows that belong to them and nothing else.
--
-- Two tables deserve their own note, below: Identity and LedgerEntry.

-- Supabase creates these roles; create them if absent so the migration also applies to
-- a plain Postgres used in development and CI.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- The Supabase auth uid of the caller. NULL when there is no JWT.
CREATE OR REPLACE FUNCTION nod_auth_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json ->> 'sub', '')
$$;

-- The NOD User row for the caller.
CREATE OR REPLACE FUNCTION nod_user_id() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM "User" WHERE "authId" = nod_auth_id() AND "deletedAt" IS NULL
$$;

-- The Brand the caller belongs to, if they are a brand user.
CREATE OR REPLACE FUNCTION nod_brand_id() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT "brandId" FROM "BrandUser" WHERE "authId" = nod_auth_id() AND "deletedAt" IS NULL
$$;

CREATE OR REPLACE FUNCTION nod_is_ops() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM "User"
    WHERE "authId" = nod_auth_id() AND role = 'OPS' AND "deletedAt" IS NULL
  )
$$;

-- ---------------------------------------------------------------- enable RLS

ALTER TABLE "User"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Identity"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SocialAccount"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Strike"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Referral"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Wallet"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerEntry"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayoutBatch"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Placement"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlacementVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlacementEvent"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Verification"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ViewSnapshot"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Dispute"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Brand"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandUser"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Campaign"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignAsset"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayoutTemplate"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Flag"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WaitlistEntry"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrandEnquiry"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyKey"   ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- ops

-- Ops reads everything. Writes still go through the application, which audits them.
CREATE POLICY ops_read_all ON "User"             FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "SocialAccount"    FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Strike"           FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Referral"         FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Wallet"           FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "LedgerEntry"      FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "PayoutBatch"      FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Placement"        FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "PlacementVersion" FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "PlacementEvent"   FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Verification"     FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "ViewSnapshot"     FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Dispute"          FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Brand"            FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "BrandUser"        FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Campaign"         FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "CampaignAsset"    FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "PayoutTemplate"   FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "AuditLog"         FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "Flag"             FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "WaitlistEntry"    FOR SELECT USING (nod_is_ops());
CREATE POLICY ops_read_all ON "BrandEnquiry"     FOR SELECT USING (nod_is_ops());

-- Identity is deliberately NOT in that list. The subject hash is a re-registration
-- control, not a support tool: no human needs to read it, and the ops console never
-- shows it. Only the service role, used by lib/state/participant.ts, can.

-- ---------------------------------------------------------------- participants

CREATE POLICY self_read ON "User"
  FOR SELECT USING (id = nod_user_id());

CREATE POLICY self_update ON "User"
  FOR UPDATE USING (id = nod_user_id()) WITH CHECK (id = nod_user_id());

CREATE POLICY own_accounts ON "SocialAccount"
  FOR SELECT USING ("userId" = nod_user_id());

CREATE POLICY own_strikes ON "Strike"
  FOR SELECT USING ("userId" = nod_user_id());

CREATE POLICY own_referrals ON "Referral"
  FOR SELECT USING ("referrerId" = nod_user_id() OR "referredId" = nod_user_id());

CREATE POLICY own_wallet ON "Wallet"
  FOR SELECT USING ("userId" = nod_user_id());

CREATE POLICY own_placements ON "Placement"
  FOR SELECT USING ("userId" = nod_user_id());

CREATE POLICY own_placement_versions ON "PlacementVersion"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Placement" p WHERE p.id = "placementId" AND p."userId" = nod_user_id())
  );

CREATE POLICY own_placement_events ON "PlacementEvent"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Placement" p WHERE p.id = "placementId" AND p."userId" = nod_user_id())
  );

CREATE POLICY own_verification ON "Verification"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Placement" p WHERE p.id = "placementId" AND p."userId" = nod_user_id())
  );

CREATE POLICY own_view_snapshots ON "ViewSnapshot"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "Verification" v
      JOIN "Placement" p ON p.id = v."placementId"
      WHERE v.id = "verificationId" AND p."userId" = nod_user_id()
    )
  );

-- A participant sees their own money. LedgerEntry rows with no walletId are campaign
-- and NOD-revenue movements, and are invisible to them by omission rather than by an
-- explicit deny — the policy simply does not grant them.
CREATE POLICY own_ledger ON "LedgerEntry"
  FOR SELECT USING (
    "walletId" IS NOT NULL
    AND EXISTS (SELECT 1 FROM "Wallet" w WHERE w.id = "walletId" AND w."userId" = nod_user_id())
  );

-- Anyone signed in can read a live campaign: that is the marketplace. Budget lives in
-- LedgerEntry, not here, so this exposes no money.
CREATE POLICY live_campaigns_readable ON "Campaign"
  FOR SELECT USING (
    state IN ('LIVE', 'FILLING') AND "deletedAt" IS NULL
  );

CREATE POLICY live_campaign_assets_readable ON "CampaignAsset"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "Campaign" c
      WHERE c.id = "campaignId" AND c.state IN ('LIVE', 'FILLING') AND c."deletedAt" IS NULL
    )
  );

CREATE POLICY live_campaign_templates_readable ON "PayoutTemplate"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "Campaign" c
      WHERE c.id = "campaignId" AND c.state IN ('LIVE', 'FILLING') AND c."deletedAt" IS NULL
    )
  );

CREATE POLICY brands_of_live_campaigns_readable ON "Brand"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "Campaign" c
      WHERE c."brandId" = "Brand".id AND c.state IN ('LIVE', 'FILLING') AND c."deletedAt" IS NULL
    )
  );

-- ---------------------------------------------------------------- brand users

CREATE POLICY own_brand ON "Brand"
  FOR SELECT USING (id = nod_brand_id());

CREATE POLICY own_brand_users ON "BrandUser"
  FOR SELECT USING ("brandId" = nod_brand_id());

CREATE POLICY own_campaigns ON "Campaign"
  FOR SELECT USING ("brandId" = nod_brand_id());

CREATE POLICY own_campaign_assets ON "CampaignAsset"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Campaign" c WHERE c.id = "campaignId" AND c."brandId" = nod_brand_id())
  );

CREATE POLICY own_payout_templates ON "PayoutTemplate"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Campaign" c WHERE c.id = "campaignId" AND c."brandId" = nod_brand_id())
  );

CREATE POLICY own_campaign_placements ON "Placement"
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM "Campaign" c WHERE c.id = "campaignId" AND c."brandId" = nod_brand_id())
  );

CREATE POLICY own_campaign_verifications ON "Verification"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "Placement" p
      JOIN "Campaign" c ON c.id = p."campaignId"
      WHERE p.id = "placementId" AND c."brandId" = nod_brand_id()
    )
  );

CREATE POLICY own_campaign_disputes ON "Dispute"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "Placement" p
      JOIN "Campaign" c ON c.id = p."campaignId"
      WHERE p.id = "placementId" AND c."brandId" = nod_brand_id()
    )
  );

CREATE POLICY own_campaign_ledger ON "LedgerEntry"
  FOR SELECT USING (
    "campaignId" IS NOT NULL
    AND EXISTS (SELECT 1 FROM "Campaign" c WHERE c.id = "campaignId" AND c."brandId" = nod_brand_id())
  );

-- A brand can see the media on its own campaign's placements — that is the review
-- queue — but never the participant's identity, wallet or strikes (docs/07 section 3:
-- "Brands see handles and post links, never email, phone, Swish, age, or identity").
CREATE POLICY own_campaign_versions ON "PlacementVersion"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "Placement" p
      JOIN "Campaign" c ON c.id = p."campaignId"
      WHERE p.id = "placementId" AND c."brandId" = nod_brand_id()
    )
  );

-- ---------------------------------------------------------------- public

-- The waitlist form and the brand enquiry form are the only anonymous writes in the
-- product. Neither is readable back without ops.
CREATE POLICY anyone_can_join_waitlist ON "WaitlistEntry" FOR INSERT WITH CHECK (true);
CREATE POLICY anyone_can_enquire ON "BrandEnquiry" FOR INSERT WITH CHECK (true);

-- Feature flags are read by every surface and contain no secrets.
CREATE POLICY flags_readable ON "Flag" FOR SELECT USING (true);

-- ---------------------------------------------------------------- deny by default
--
-- Every table above has RLS enabled, so any table with no policy for a given role and
-- command denies it. That covers, deliberately:
--
--   Identity        — nobody but the service role, ever
--   AuditLog        — ops only; it records who did what and is not a user-facing log
--   PayoutBatch     — ops only
--   IdempotencyKey  — service role only
--   every INSERT/UPDATE/DELETE on money and placement tables — the application writes
--                     them through the state machines, never a client
--
-- LedgerEntry is worth stating explicitly: it is append-only by application rule
-- (lib/money/ledger.ts) and now also by RLS, because no UPDATE or DELETE policy exists
-- for any role but the owner.

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON "Campaign", "CampaignAsset", "PayoutTemplate", "Brand", "Flag" TO anon;
GRANT INSERT ON "WaitlistEntry", "BrandEnquiry" TO anon, authenticated;
GRANT UPDATE ON "User" TO authenticated;
