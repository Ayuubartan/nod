# Renders each narration line to a WAV with the Windows speech synthesizer (SAPI).
# Usage: powershell -NoProfile -File scripts/intro-video/tts.ps1 [-OutDir <dir>]
# Windows only; the render script falls back to a silent track when the files are missing.
param([string]$OutDir = "scripts/intro-video/.build/vo")

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$spec = Get-Content (Join-Path $here 'narration.json') -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.SelectVoice($spec.voice) } catch { Write-Warning "Voice '$($spec.voice)' not installed; using default." }
$synth.Rate = [int]$spec.rate

foreach ($line in $spec.lines) {
  $path = Join-Path $OutDir ($line.id + '.wav')
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($line.text)
  $synth.SetOutputToNull()
  Write-Host "wrote $path"
}
$synth.Dispose()
