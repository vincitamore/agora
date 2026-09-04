#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Room,

    [string]$Actor,

    [string]$SessionId = $(if ($env:CODEX_SESSION_ID) { $env:CODEX_SESSION_ID } else { $env:CODEX_THREAD_ID }),
    [string]$ThreadId = $(if ($env:CODEX_THREAD_ID) { $env:CODEX_THREAD_ID } else { $env:CODEX_SESSION_ID }),
    [string]$ConfigPath = $(if ($env:AGORA_CONFIG) { $env:AGORA_CONFIG } else { Join-Path $env:USERPROFILE '.agora\config.json' }),
    [string]$StateRoot = $(if ($env:AGORA_STATE) { $env:AGORA_STATE } else { Join-Path $env:USERPROFILE '.agora\state' }),
    [Alias('BunPath')]
    [string]$RuntimePath,
    [string]$CodexPath = $env:AGORA_CODEX_BIN,
    [string]$LogPrefix,
    [double]$ThreadInterval = 120,
    [switch]$Status,
    [switch]$Stop,
    [switch]$Force,
    [switch]$Worker
)

$ErrorActionPreference = 'Stop'
$agoraPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\bin\agora.mjs'))

if (-not $SessionId -or $SessionId -notmatch '^[A-Za-z0-9-]{8,128}$') {
    throw 'A Codex CODEX_SESSION_ID is required for the stable watch session.'
}
if (-not $ThreadId -or $ThreadId -notmatch '^[A-Za-z0-9-]{8,128}$') {
    throw 'A Codex CODEX_THREAD_ID or CODEX_SESSION_ID is required for the queue target.'
}
if ([double]::IsNaN($ThreadInterval) -or [double]::IsInfinity($ThreadInterval) -or $ThreadInterval -le 0) {
    throw 'ThreadInterval must be a positive number.'
}
if (-not $LogPrefix) {
    # A machine may host several Codex bearers at once. A process holding PowerShell's append
    # redirection keeps the file open, so one machine-global prefix makes the next worker fail
    # before it can arm. Session + room is the same uniqueness boundary as the armed record.
    $safeRoom = $Room -replace '[^A-Za-z0-9._-]', '_'
    $LogPrefix = Join-Path ([IO.Path]::GetTempPath()) "agora-codex-watch-$SessionId-$safeRoom"
}

$sessionSlug = "codex-$SessionId"
$armedPath = Join-Path $StateRoot "sessions\$sessionSlug\armed\$Room.json"

function Get-ArmedWatch {
    if (-not (Test-Path -LiteralPath $armedPath -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -LiteralPath $armedPath | ConvertFrom-Json }
    catch { throw "Could not read armed watch record $armedPath`: $($_.Exception.Message)" }
}

function Get-SupervisorPid([int]$WatcherPid) {
    $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$WatcherPid" -ErrorAction SilentlyContinue
    if ($proc -and $proc.ParentProcessId) { return [int]$proc.ParentProcessId }
    return $null
}

function Stop-ArmedWatch($Armed) {
    if (-not $Armed -or -not $Armed.pid) { return $null }
    $watcherPid = [int]$Armed.pid
    $supervisorPid = Get-SupervisorPid $watcherPid
    Stop-Process -Id $watcherPid -Force -ErrorAction SilentlyContinue
    if ($supervisorPid) {
        Start-Sleep -Milliseconds 150
        Stop-Process -Id $supervisorPid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $armedPath -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ watcherPid = $watcherPid; supervisorPid = $supervisorPid }
}

$armed = Get-ArmedWatch
if ($Status) {
    $watcherPid = if ($armed -and $armed.pid) { [int]$armed.pid } else { $null }
    $alive = [bool]($watcherPid -and (Get-Process -Id $watcherPid -ErrorAction SilentlyContinue))
    [pscustomobject]@{
        room = $Room
        session = $SessionId
        watcherPid = $watcherPid
        supervisorPid = $(if ($alive) { Get-SupervisorPid $watcherPid } else { $null })
        alive = $alive
        armed = $armedPath
    } | ConvertTo-Json -Compress
    exit 0
}
if ($Stop) {
    $stopped = Stop-ArmedWatch $armed
    [pscustomobject]@{
        room = $Room
        session = $SessionId
        stopped = [bool]$stopped
        watcherPid = $(if ($stopped) { $stopped.watcherPid } else { $null })
        supervisorPid = $(if ($stopped) { $stopped.supervisorPid } else { $null })
        armed = $armedPath
    } | ConvertTo-Json -Compress
    exit 0
}
if (-not $Worker -and (-not $Actor)) { throw '-Actor is required when arming a watch.' }
if (-not $Worker -and $armed -and (Get-Process -Id ([int]$armed.pid) -ErrorAction SilentlyContinue)) {
    if (-not $Force) { throw "A live watch already holds $Room for this Codex session (pid $($armed.pid)). Use -Status, -Stop, or -Force." }
    Stop-ArmedWatch $armed > $null
}
elseif (-not $Worker -and $armed) {
    # The spawn loop reads this file to discover the new watcher. A dead record would make it
    # return the previous PID before the new watch has had a chance to replace the record.
    Remove-Item -LiteralPath $armedPath -Force
    $armed = $null
}

function Resolve-ExecutablePath {
    param(
        [string]$Explicit,
        [string[]]$Names,
        [string[]]$Candidates,
        [string]$Label
    )

    if ($Explicit) {
        $resolved = Get-Command $Explicit -ErrorAction SilentlyContinue
        if ($resolved -and $resolved.CommandType -eq 'Application') { return $resolved.Source }
        if (Test-Path -LiteralPath $Explicit -PathType Leaf) { return (Resolve-Path -LiteralPath $Explicit).Path }
        throw "$Label executable not found at '$Explicit'."
    }

    foreach ($name in $Names) {
        $resolved = Get-Command $name -ErrorAction SilentlyContinue
        if ($resolved -and $resolved.CommandType -eq 'Application') { return $resolved.Source }
    }
    foreach ($candidate in $Candidates | Where-Object { $_ }) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw "$Label executable not found. Pass the path explicitly."
}

$runtimeCandidates = @(
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' }),
    $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.bun\bin\bun.exe' })
)
$RuntimePath = Resolve-ExecutablePath -Explicit $RuntimePath -Names @('node.exe', 'bun.exe') -Candidates $runtimeCandidates -Label 'Node or Bun runtime'

$codexCandidates = @($env:CODEX_CLI_PATH)
if ($env:ProgramFiles) {
    $codexCandidates += Join-Path $env:ProgramFiles 'nodejs\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
}
if ($env:APPDATA) {
    $codexCandidates += Get-ChildItem -Path (Join-Path $env:APPDATA 'nvm\*\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe') -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -ExpandProperty FullName
}
if ($env:LOCALAPPDATA) {
    $codexCandidates += Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe') -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -ExpandProperty FullName
}
$CodexPath = Resolve-ExecutablePath -Explicit $CodexPath -Names @('codex.exe') -Candidates $codexCandidates -Label 'Codex CLI'

if ($Worker) {
    $env:AGORA_ACTOR = $Actor
    $env:AGORA_CONFIG = $ConfigPath
    $env:AGORA_STATE = $StateRoot
    # The detached worker is the durable process for this resident seat. Recording its pid makes
    # liveness measurable without pretending the transient shell that launched it is the session.
    $env:AGORA_SESSION_PID = [string]$PID
    $env:CODEX_SESSION_ID = $SessionId
    Remove-Item Env:AGORA_SESSION -ErrorAction SilentlyContinue
    $env:PATH = @((Split-Path $CodexPath), (Split-Path $RuntimePath), $env:PATH) -join ';'

    $stdoutPath = "$LogPrefix.stdout.log"
    $stderrPath = "$LogPrefix.stderr.log"
    & $RuntimePath $agoraPath watch $Room --stream --follow --json --wake addressed --thread-interval $ThreadInterval --coalesce 20 --codex-queue --codex-thread $ThreadId --codex-bin $CodexPath 1>> $stdoutPath 2>> $stderrPath
    exit $LASTEXITCODE
}

function ConvertTo-ProcessArgument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$workerArgs = @(
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-File', $PSCommandPath,
    '-Worker',
    '-Room', $Room,
    '-Actor', $Actor,
    '-SessionId', $SessionId,
    '-ThreadId', $ThreadId,
    '-ConfigPath', $ConfigPath,
    '-StateRoot', $StateRoot,
    '-RuntimePath', $RuntimePath,
    '-CodexPath', $CodexPath,
    '-LogPrefix', $LogPrefix,
    '-ThreadInterval', [string]$ThreadInterval
)
$commandLine = (ConvertTo-ProcessArgument $pwshPath) + ' ' + (($workerArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = (Get-Location).Path
}

if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
    throw "Win32_Process.Create failed with return code $($created.ReturnValue)."
}

$watcherPid = $null
for ($attempt = 0; $attempt -lt 100 -and -not $watcherPid; $attempt++) {
    Start-Sleep -Milliseconds 100
    $started = Get-ArmedWatch
    if ($started -and $started.pid) { $watcherPid = [int]$started.pid }
    elseif (-not (Get-Process -Id ([int]$created.ProcessId) -ErrorAction SilentlyContinue)) { break }
}

if (-not $watcherPid) {
    Stop-Process -Id ([int]$created.ProcessId) -Force -ErrorAction SilentlyContinue
    throw "Codex watch did not arm within 10 seconds. Inspect $LogPrefix.stderr.log."
}

[pscustomobject]@{
    supervisorPid = [int]$created.ProcessId
    watcherPid = $watcherPid
    room = $Room
    actor = $Actor
    session = $SessionId
    stdout = "$LogPrefix.stdout.log"
    stderr = "$LogPrefix.stderr.log"
} | ConvertTo-Json -Compress
