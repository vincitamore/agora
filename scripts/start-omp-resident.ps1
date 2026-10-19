# Start a resident OMP (@oh-my-pi) session from a profile (Windows).
#
#   scripts/start-omp-resident.ps1 -Slug <slug> -Profile <path> [-Model <name>] [-Thinking <level>]
#                                  [-Resume <session-id>] [-Skills <csv>] [-Cwd <dir>]
#
# Renders the prompt (`agora resident prompt`: the profile plus the shipped room-mechanics block)
# to the seat's state under residents\<slug>\, moves to -Cwd (the tree the resident works in),
# and runs `omp` with the rendered file appended to the system prompt and yolo approval mode.
param(
  [Parameter(Mandatory = $true)][string]$Slug,
  [Parameter(Mandatory = $true)][string]$Profile,
  [string]$Model = "",
  [string]$Thinking = "",
  [string]$Resume = "",
  [string]$Skills = "",
  [string]$Cwd = ""
)
$ErrorActionPreference = "Stop"
$agora = Join-Path $PSScriptRoot "..\bin\agora.mjs"
if (-not (Test-Path $Profile)) { throw "profile missing: $Profile" }

$state = if ($env:AGORA_STATE) { $env:AGORA_STATE } else { Join-Path $HOME ".agora\state" }
$outdir = Join-Path $state "residents\$Slug"
New-Item -ItemType Directory -Force $outdir | Out-Null
$rendered = Join-Path $outdir "profile.rendered.md"
$prompt = & node $agora resident prompt $Profile
if ($LASTEXITCODE -ne 0) { throw "agora resident prompt failed ($LASTEXITCODE)" }
[IO.File]::WriteAllText($rendered, (($prompt -join "`n") + "`n"))

if ($Cwd) { Set-Location $Cwd }

$ompArgs = @("--append-system-prompt", $rendered, "--approval-mode", "yolo")
if ($Model)    { $ompArgs += @("--model", $Model) }
if ($Thinking) { $ompArgs += @("--thinking", $Thinking) }
if ($Skills)   { $ompArgs += @("--skills", $Skills) }
if ($Resume) {
  $ompArgs += @("--resume", $Resume)
} else {
  $ompArgs += "You are the $Slug resident. Run the arming sequence in your profile now, then report the room state in one line."
}
& omp @ompArgs
