# Start a resident Claude Code session from a profile (Windows).
#
#   scripts/start-claude-resident.ps1 -Slug <slug> -Profile <path> [-Model <name>] [-Effort <level>]
#                                     [-Resume <session-id>] [-Cwd <dir>]
#
# Renders the prompt (`agora resident prompt`: the profile plus the shipped room-mechanics block)
# to the seat's state under residents\<slug>\, moves to -Cwd (the tree the resident works in),
# and runs Claude Code with the rendered file as the whole system prompt. See docs/RESIDENTS.md.
param(
  [Parameter(Mandatory = $true)][string]$Slug,
  [Parameter(Mandatory = $true)][string]$Profile,
  [string]$Model = "",
  [string]$Effort = "",
  [string]$Resume = "",
  [string]$Cwd = ""
)
$ErrorActionPreference = "Stop"
$agora = Join-Path $PSScriptRoot "..\bin\agora.mjs"
if (-not (Test-Path $Profile)) { throw "profile missing: $Profile" }

$state = if ($env:AGORA_STATE) { $env:AGORA_STATE } else { Join-Path $HOME ".agora" }
$outdir = Join-Path $state "residents\$Slug"
New-Item -ItemType Directory -Force $outdir | Out-Null
$rendered = Join-Path $outdir "profile.rendered.md"
$prompt = & node $agora resident prompt $Profile
if ($LASTEXITCODE -ne 0) { throw "agora resident prompt failed ($LASTEXITCODE)" }
[IO.File]::WriteAllText($rendered, (($prompt -join "`n") + "`n"))

if ($Cwd) { Set-Location $Cwd }

$claudeArgs = @("--system-prompt", ".", "--append-system-prompt-file", $rendered, "--dangerously-skip-permissions")
if ($Model)  { $claudeArgs += @("--model", $Model) }
if ($Effort) { $claudeArgs += @("--effort", $Effort) }
if ($Resume) {
  $claudeArgs += @("--resume", $Resume)
} else {
  $claudeArgs += "You are the $Slug resident. Run the arming sequence in your profile now, then report the room state in one line."
}
& claude @claudeArgs
