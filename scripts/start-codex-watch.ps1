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
    [string]$CodexServer = $env:AGORA_CODEX_SERVER,
    [string]$CodexTokenFile = $env:AGORA_CODEX_TOKEN_FILE,
    [string]$LogPrefix,
    [double]$ThreadInterval = 120,
    [int]$ArmingTimeoutSeconds = 60,
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
if ($ArmingTimeoutSeconds -le 0) {
    throw 'ArmingTimeoutSeconds must be a positive integer.'
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
    # A watch that ended for a transport reason wrote one watch-ended line to its stdout log; when
    # the armed pid is gone, that line is the reason, so -Status carries it.
    $ended = $null
    $stdoutLog = "$LogPrefix.stdout.log"
    if (-not $alive -and (Test-Path $stdoutLog)) {
        $lastEnded = Select-String -Path $stdoutLog -Pattern '"type":"watch-ended"' -SimpleMatch | Select-Object -Last 1
        if ($lastEnded) { try { $ended = $lastEnded.Line | ConvertFrom-Json } catch { $ended = $lastEnded.Line } }
    }
    [pscustomobject]@{
        room = $Room
        session = $SessionId
        watcherPid = $watcherPid
        supervisorPid = $(if ($alive) { Get-SupervisorPid $watcherPid } else { $null })
        alive = $alive
        armingTimeoutSeconds = $ArmingTimeoutSeconds
        armed = $armedPath
        ended = $ended
    } | ConvertTo-Json -Compress -Depth 4
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

# Codex applies its shell-environment policy to model-reachable commands, so a retained TUI may
# preserve CODEX_THREAD_ID while omitting the app-server references inherited by the TUI process.
# The protected seat-local descriptor is the authoritative fallback. Authenticate it through the
# Agora status verb; never fall back to the legacy queue while a managed descriptor is present.
if (-not $CodexServer -and -not $CodexTokenFile) {
    $managedDescriptor = Join-Path $StateRoot 'codex-control\server.json'
    if (Test-Path -LiteralPath $managedDescriptor -PathType Leaf) {
        $managedStatusText = & $RuntimePath $agoraPath codex status --json 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw 'A managed Codex server descriptor exists but could not be authenticated; refusing legacy queue fallback.'
        }
        try { $managedStatus = $managedStatusText | ConvertFrom-Json }
        catch { throw 'The managed Codex server returned an invalid status; refusing legacy queue fallback.' }
        if (-not $managedStatus.running -or -not $managedStatus.endpoint -or -not $managedStatus.tokenFile -or
            -not [IO.Path]::IsPathRooted([string]$managedStatus.tokenFile) -or
            -not (Test-Path -LiteralPath ([string]$managedStatus.tokenFile) -PathType Leaf)) {
            throw 'A managed Codex server descriptor exists but its authenticated connection is unavailable; refusing legacy queue fallback.'
        }
        $CodexServer = [string]$managedStatus.endpoint
        $CodexTokenFile = [string]$managedStatus.tokenFile
    }
}

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
    $deliveryArgs = if ($CodexServer) { @('--codex-server', $CodexServer, '--codex-token-file', $CodexTokenFile) } else { @('--codex-queue', '--codex-bin', $CodexPath) }
    & $RuntimePath $agoraPath watch $Room --stream --follow --json --wake addressed --thread-interval $ThreadInterval --coalesce 20 --max-batch 32 --codex-thread $ThreadId @deliveryArgs 1>> $stdoutPath 2>> $stderrPath
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
if ($CodexServer) {
    if (-not $CodexTokenFile -or -not [IO.Path]::IsPathRooted($CodexTokenFile) -or -not (Test-Path -LiteralPath $CodexTokenFile -PathType Leaf)) {
        throw '-CodexServer requires an existing absolute -CodexTokenFile.'
    }
    $workerArgs += @('-CodexServer', $CodexServer, '-CodexTokenFile', $CodexTokenFile)
}
elseif ($CodexTokenFile) { throw '-CodexTokenFile requires -CodexServer.' }
$commandLine = (ConvertTo-ProcessArgument $pwshPath) + ' ' + (($workerArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')
# A new arm starts a new stdout log: -Status returns the last watch-ended line once the pid is
# gone, and with an appended log that line could be an earlier arm's ending.
New-Item -ItemType Directory -Force -Path (Split-Path $LogPrefix) | Out-Null
[IO.File]::WriteAllText("$LogPrefix.stdout.log", '')
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = (Get-Location).Path
}

if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
    throw "Win32_Process.Create failed with return code $($created.ReturnValue)."
}

$watcherPid = $null
$armingClock = [Diagnostics.Stopwatch]::StartNew()
while (-not $watcherPid -and $armingClock.Elapsed.TotalSeconds -lt $ArmingTimeoutSeconds) {
    Start-Sleep -Milliseconds 100
    $started = Get-ArmedWatch
    if ($started -and $started.pid) { $watcherPid = [int]$started.pid }
    elseif (-not (Get-Process -Id ([int]$created.ProcessId) -ErrorAction SilentlyContinue)) { break }
}
$armingClock.Stop()

if (-not $watcherPid) {
    Stop-Process -Id ([int]$created.ProcessId) -Force -ErrorAction SilentlyContinue
    throw "Codex watch did not publish its subscribed armed receipt within $ArmingTimeoutSeconds seconds. Inspect $LogPrefix.stderr.log."
}

[pscustomobject]@{
    supervisorPid = [int]$created.ProcessId
    watcherPid = $watcherPid
    room = $Room
    actor = $Actor
    session = $SessionId
    armingTimeoutSeconds = $ArmingTimeoutSeconds
    stdout = "$LogPrefix.stdout.log"
    stderr = "$LogPrefix.stderr.log"
} | ConvertTo-Json -Compress
