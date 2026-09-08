#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CodexPath,
    [Parameter(Mandatory = $true)][string]$Endpoint,
    [Parameter(Mandatory = $true)][string]$TokenFile,
    [Parameter(Mandatory = $true)][string]$CurrentDirectory,
    [Parameter(Mandatory = $true)][string]$ReceiptPath,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [switch]$Worker
)

$ErrorActionPreference = 'Stop'

function ConvertTo-ProcessArgument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

if (-not [IO.Path]::IsPathRooted($CodexPath) -or -not (Test-Path -LiteralPath $CodexPath -PathType Leaf)) {
    throw 'CodexPath must name an existing absolute executable.'
}
if ($Endpoint -notmatch '^ws://127\.0\.0\.1:[0-9]+$') {
    throw 'Endpoint must be a literal IPv4 loopback websocket URL.'
}
foreach ($item in @($TokenFile, $CurrentDirectory, $ReceiptPath, $StdoutPath, $StderrPath)) {
    if (-not [IO.Path]::IsPathRooted($item)) { throw 'Every app-server path must be absolute.' }
}
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) { throw 'TokenFile must name an existing file.' }
if (-not (Test-Path -LiteralPath $CurrentDirectory -PathType Container)) { throw 'CurrentDirectory must name an existing directory.' }

$argv = @('app-server', '--listen', $Endpoint, '--ws-auth', 'capability-token', '--ws-token-file', $TokenFile)
if ($Worker) {
    $env:AGORA_CODEX_SERVER = $Endpoint
    $env:AGORA_CODEX_TOKEN_FILE = $TokenFile
    Remove-Item Env:AGORA_CODEX_REMOTE_AUTH_TOKEN -ErrorAction SilentlyContinue
    $server = Start-Process -FilePath $CodexPath -ArgumentList @($argv | ForEach-Object { ConvertTo-ProcessArgument $_ }) -WorkingDirectory $CurrentDirectory `
        -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru
    $temp = "$ReceiptPath.$PID.tmp"
    [IO.File]::WriteAllText($temp, ([pscustomobject]@{ pid = [int]$server.Id; supervisorPid = [int]$PID } | ConvertTo-Json -Compress))
    Move-Item -LiteralPath $temp -Destination $ReceiptPath -Force
    Wait-Process -Id $server.Id
    exit $server.ExitCode
}

Remove-Item -LiteralPath $ReceiptPath -Force -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($StdoutPath, '')
[IO.File]::WriteAllText($StderrPath, '')
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$workerArgs = @(
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', $PSCommandPath, '-Worker',
    '-CodexPath', $CodexPath, '-Endpoint', $Endpoint, '-TokenFile', $TokenFile,
    '-CurrentDirectory', $CurrentDirectory, '-ReceiptPath', $ReceiptPath,
    '-StdoutPath', $StdoutPath, '-StderrPath', $StderrPath
)
$commandLine = (ConvertTo-ProcessArgument $pwshPath) + ' ' + (($workerArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = $CurrentDirectory
}
if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
    throw "Win32_Process.Create failed with return code $($created.ReturnValue)."
}

$clock = [Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf) -and $clock.Elapsed.TotalSeconds -lt 15) {
    Start-Sleep -Milliseconds 100
    if (-not (Get-Process -Id ([int]$created.ProcessId) -ErrorAction SilentlyContinue)) { break }
}
$clock.Stop()
if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) {
    Stop-Process -Id ([int]$created.ProcessId) -Force -ErrorAction SilentlyContinue
    throw "Codex app-server worker did not publish its process receipt. Inspect $StderrPath."
}
Get-Content -Raw -LiteralPath $ReceiptPath
