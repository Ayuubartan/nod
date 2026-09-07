# Seeds the Vercel production environment with everything that does not come from a
# third-party dashboard: two generated secrets and the fixed configuration.
#
#   powershell -NoProfile -File scripts/vercel-env.ps1
#
# Run once, after `vercel link`. Idempotent (--force overwrites). The Supabase and Resend
# values are deliberately not here — paste those in the Vercel dashboard (docs/12).
# Generating BANKID_SUBJECT_SALT twice would orphan every verified participant, so the
# script refuses to overwrite it if it already exists.

$ErrorActionPreference = 'Stop'

function Set-VercelEnv([string]$Name, [string]$Value, [switch]$KeepExisting) {
  if ($KeepExisting) {
    $existing = vercel env ls production 2>$null | Select-String -Pattern "^\s*$Name\s"
    if ($existing) { Write-Host "  $Name  (kept)"; return }
  }
  $Value | vercel env add $Name production --force | Out-Null
  Write-Host "  $Name  (set)"
}

$rand = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-Secret([int]$Bytes) {
  $buf = New-Object byte[] $Bytes
  $rand.GetBytes($buf)
  return [Convert]::ToBase64String($buf)
}

Write-Host "Production environment for the linked Vercel project:"
Set-VercelEnv 'ENCRYPTION_KEY'        (New-Secret 32) -KeepExisting
Set-VercelEnv 'BANKID_SUBJECT_SALT'   (New-Secret 48) -KeepExisting
Set-VercelEnv 'NOD_MARKET'            'SE'
Set-VercelEnv 'NOD_FAKE_PROVIDERS'    '1'
Set-VercelEnv 'SUPABASE_STORAGE_BUCKET' 'nod-media'
Set-VercelEnv 'EMAIL_FROM'            'NOD <hello@nod.se>'
Set-VercelEnv 'OPS_EMAIL'             'ops@nod.se'
Set-VercelEnv 'NEXT_PUBLIC_SITE_URL'  'https://nod-ayuubartans-projects.vercel.app'

Write-Host ""
Write-Host "Still needed (Vercel dashboard -> Settings -> Environment Variables):"
Write-Host "  DATABASE_URL, DIRECT_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,"
Write-Host "  SUPABASE_SERVICE_ROLE_KEY   (Supabase)"
Write-Host "  RESEND_API_KEY              (Resend)"
Write-Host "Then: vercel --prod"
