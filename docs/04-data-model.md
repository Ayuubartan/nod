# 04 — Data Model

PostgreSQL via Prisma. All tables: `id` (cuid), `created_at`, `updated_at`, `deleted_at?`. Money columns are `Int` in öre. Enums mirror `docs/03-workflows.md` exactly.

## Entity map

```
User ──1:1── Identity (BankID hash)
User ──1:N── SocialAccount
User ──1:1── Wallet ──1:N── LedgerEntry
User ──1:N── Placement ──N:1── Campaign ──N:1── Brand ──1:N── BrandUser
Campaign ──1:N── CampaignAsset
Campaign ──1:1── PayoutTemplate
Placement ──1:N── PlacementVersion (each generation)
Placement ──1:N── PlacementEvent (training signal)
Placement ──1:1── Verification ──1:N── ViewSnapshot
User ──1:N── Strike
User ──1:N── Referral
WaitlistEntry, BrandEnquiry (marketing)
AuditLog (every transition), Flag (feature flags)
```

## Prisma schema (starting point — extend, don't diverge)

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum Role { PARTICIPANT BRAND OPS }
enum ParticipantState { SIGNED_UP ONBOARDED VERIFIED ACTIVE FLAGGED SUSPENDED REMOVED }
enum AccountPlatform { INSTAGRAM TIKTOK }
enum AccountTier { CONNECTED_API CONNECTED_SCREENSHOT BELOW_FLOOR DISCONNECTED }
enum CampaignState { DRAFT SUBMITTED RETURNED AWAITING_FUNDS FUNDED LIVE FILLING EXHAUSTED EXPIRED PAUSED RECONCILING CLOSED }
enum ReviewTier { A B }
enum PayoutKind { FIXED CPM HYBRID HYBRID_BONUS }
enum PlacementState {
  CLAIMED UPLOADED POSITIONED GENERATING GENERATION_FAILED
  PARTICIPANT_REVIEW BRAND_REVIEW APPROVED PUBLISHED VERIFYING FLAGGED
  QUALIFIED PAID REJECTED EXPIRED REJECTED_BY_PARTICIPANT REJECTED_BY_BRAND DISPUTED
}
enum RejectReason { NO_DISCLOSURE MEDIA_MISMATCH WRONG_ACCOUNT DELETED_EARLY FRAUD BRAND_SAFETY OTHER }
enum LedgerType { DEPOSIT RESERVE RELEASE_RESERVATION SETTLE PAYOUT_ACCRUE TAKE PAYOUT_SENT REFUND ROLLOVER CREDIT_TERMS_FEE ADJUSTMENT }
enum StrikeSeverity { MINOR SERIOUS }

model User {
  id                 String   @id @default(cuid())
  authId             String   @unique            // supabase auth uid
  role               Role     @default(PARTICIPANT)
  state              ParticipantState @default(SIGNED_UP)
  locale             String   @default("sv")
  city               String?
  ageBracket         String?                     // "18-20" | "21-25" | "26-30" | "31+"
  swishNumber        String?                     // E.164, encrypted at rest
  trainingConsent    Boolean  @default(false)
  disclosureQuizAt   DateTime?
  termsAcceptedAt    DateTime?
  pushSubscription   Json?
  referralCode       String   @unique
  referredById       String?
  reputation         Int      @default(0)
  identity           Identity?
  accounts           SocialAccount[]
  wallet             Wallet?
  placements         Placement[]
  strikes            Strike[]
  createdAt DateTime @default(now()) updatedAt DateTime @updatedAt deletedAt DateTime?
}

model Identity {                                  // BankID — minimum data
  id           String @id @default(cuid())
  userId       String @unique
  subjectHash  String @unique                     // sha256(provider subject + salt); dedupe + block re-register
  birthYear    Int
  verifiedAt   DateTime
  provider     String                             // "criipto:se-bankid"
  user         User @relation(fields: [userId], references: [id])
}

model SocialAccount {
  id             String @id @default(cuid())
  userId         String
  platform       AccountPlatform
  handle         String
  platformUserId String
  tier           AccountTier
  accountType    String?                          // personal | creator | business
  isPrivate      Boolean @default(false)
  followers      Int @default(0)
  avgViews30d    Int @default(0)
  categories     String[]
  accessToken    String?                          // encrypted
  tokenExpiresAt DateTime?
  lastSyncedAt   DateTime?
  user           User @relation(fields: [userId], references: [id])
  placements     Placement[]
  @@unique([platform, platformUserId])
}

model Brand {
  id        String @id @default(cuid())
  name      String
  orgNumber String?
  users     BrandUser[]
  campaigns Campaign[]
  stripeCustomerId String?
}

model BrandUser { id String @id @default(cuid()); brandId String; authId String @unique; email String; role String @default("member"); brand Brand @relation(fields: [brandId], references: [id]) }

model Campaign {
  id            String @id @default(cuid())
  brandId       String
  name          String
  state         CampaignState @default(DRAFT)
  objective     String @default("awareness")
  startsAt      DateTime?
  endsAt        DateTime?
  goLiveAt      DateTime?
  // audience
  countries     String[] @default(["SE"])
  cities        String[]
  ageBrackets   String[]
  minFollowers  Int @default(300)
  maxFollowers  Int?
  categories    String[]
  exclusions    String[]
  // rules
  rulesText     String?
  brandSafety   String[]
  reviewTier    ReviewTier @default(B)
  disclosureText String
  perPersonCap  Int @default(2)
  // money (öre)
  budget        Int
  perPlacementMax Int
  payoutTemplate PayoutTemplate?
  fundedVia     String?                           // card | invoice
  creditTermsFeeBps Int @default(0)
  brand         Brand @relation(fields: [brandId], references: [id])
  assets        CampaignAsset[]
  placements    Placement[]
  ledger        LedgerEntry[]
}

model PayoutTemplate {                            // brand-facing (all-in) numbers; participant share derived via take rate
  id            String @id @default(cuid())
  campaignId    String @unique
  kind          PayoutKind
  fixedOre      Int @default(0)                   // per approved placement
  cpmOre        Int @default(0)                   // per 1000 qualified views
  bonusAtViews  Int?
  bonusOre      Int?
  viewFloor     Int @default(100)                 // below → fixed only
  takeRateBps   Int @default(2800)                // snapshot at funding; never changed after
  campaign      Campaign @relation(fields: [campaignId], references: [id])
}

model CampaignAsset { id String @id @default(cuid()); campaignId String; name String; storagePath String; placementTypes String[]; campaign Campaign @relation(fields: [campaignId], references: [id]) }

model Placement {
  id              String @id @default(cuid())
  campaignId      String
  userId          String
  socialAccountId String
  state           PlacementState @default(CLAIMED)
  rejectReason    RejectReason?
  reservationOre  Int
  claimedAt       DateTime @default(now())
  deadlineAt      DateTime                         // current timer, moved on each timed state
  clockPausedAt   DateTime?
  originalPath    String?
  originalHash    String?                          // perceptual hash for duplicates + media match
  regionJson      Json?                            // chosen surface {x,y,w,h,label}
  assetId         String?
  regenCount      Int @default(0)
  currentVersionId String?
  postUrl         String?
  postPlatformId  String?
  publishedAt     DateTime?
  holdEndsAt      DateTime?
  disclosureTextIssued String?
  campaign        Campaign @relation(fields: [campaignId], references: [id])
  user            User @relation(fields: [userId], references: [id])
  account         SocialAccount @relation(fields: [socialAccountId], references: [id])
  versions        PlacementVersion[]
  events          PlacementEvent[]
  verification    Verification?
  @@index([campaignId, state]) @@index([userId, state]) @@index([deadlineAt])
}

model PlacementVersion { id String @id @default(cuid()); placementId String; storagePath String; engine String; params Json?; createdAt DateTime @default(now()); placement Placement @relation(fields: [placementId], references: [id]) }

model PlacementEvent {                             // training signal
  id          String @id @default(cuid())
  placementId String
  type        String                               // CANDIDATES_SHOWN | REGION_PICKED | REGEN | MOVE | SWAP | APPROVE | REJECT_P | REJECT_B | BRAND_SAMPLE_OK
  payload     Json
  createdAt   DateTime @default(now())
  placement   Placement @relation(fields: [placementId], references: [id])
}

model Verification {
  id             String @id @default(cuid())
  placementId    String @unique
  accountMatch   Boolean?
  disclosureOk   Boolean?
  labelOk        Boolean?
  mediaMatch     Float?
  views          Int?
  viewsSource    String?                           // api | screenshot
  screenshotPath String?
  fraudScore     Float?
  fraudFactors   Json?
  geoFactor      Float @default(1)
  qualifiedViews Int?
  decidedBy      String?                           // system | ops:<id>
  decidedAt      DateTime?
  placement      Placement @relation(fields: [placementId], references: [id])
  snapshots      ViewSnapshot[]
}
model ViewSnapshot { id String @id @default(cuid()); verificationId String; at DateTime @default(now()); views Int; reach Int?; source String; verification Verification @relation(fields: [verificationId], references: [id]) }

model Wallet { id String @id @default(cuid()); userId String @unique; user User @relation(fields: [userId], references: [id]); entries LedgerEntry[] }

model LedgerEntry {                                // append-only; never update or delete
  id           String @id @default(cuid())
  type         LedgerType
  amountOre    Int
  campaignId   String?
  walletId     String?
  placementId  String?
  memo         String?
  externalRef  String?                             // stripe pi, swish ref
  createdAt    DateTime @default(now())
  campaign     Campaign? @relation(fields: [campaignId], references: [id])
  wallet       Wallet? @relation(fields: [walletId], references: [id])
  @@index([campaignId, type]) @@index([walletId, type])
}

model Strike { id String @id @default(cuid()); userId String; severity StrikeSeverity; reason String; placementId String?; createdAt DateTime @default(now()); user User @relation(fields: [userId], references: [id]) }
model Referral { id String @id @default(cuid()); referrerId String; referredId String @unique; firstPlacementAt DateTime?; bonusPaidAt DateTime? }
model WaitlistEntry { id String @id @default(cuid()); handle String; platform AccountPlatform; city String; ageBracket String; followersBracket String; categories String[]; email String; referralCode String @unique; referredBy String?; consentAt DateTime; createdAt DateTime @default(now()) }
model BrandEnquiry { id String @id @default(cuid()); company String; name String; email String; budgetBracket String; objective String?; message String?; createdAt DateTime @default(now()) }
model AuditLog { id String @id @default(cuid()); entity String; entityId String; fromState String?; toState String?; event String; actor String; payload Json?; createdAt DateTime @default(now()); @@index([entity, entityId]) }
model Flag { key String @id; value Json; updatedAt DateTime @updatedAt }
```

## Derived numbers (never stored)

```ts
campaign.available = Σ DEPOSIT − Σ RESERVE + Σ RELEASE_RESERVATION − Σ REFUND − Σ ROLLOVER + Σ(SETTLE remainder)
campaign.reserved  = Σ RESERVE − Σ RELEASE_RESERVATION − Σ SETTLE(reserved side)
campaign.spent     = Σ PAYOUT_ACCRUE + Σ TAKE
wallet.available   = Σ PAYOUT_ACCRUE − Σ PAYOUT_SENT
```

Implement these as SQL views or Prisma raw queries with tests; UI reads views only.

## Retention

- `PlacementVersion` originals: 90 days after terminal, then deleted unless `trainingConsent` (then anonymised copy moved to training bucket)
- `Verification.screenshotPath`: 30 days after decision
- `AuditLog`, `LedgerEntry`: 7 years (bookkeeping)
- `Identity.subjectHash`: retained after `REMOVED` to block re-registration; everything else erased on GDPR job
