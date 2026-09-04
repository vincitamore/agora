#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Room,

    [Parameter(Mandatory = $true)]
    [string]$Actor,

    [string]$SessionId = $(if ($env:CODEX_THREAD_ID) { $env:CODEX_THREAD_ID } else { $env:CODEX_SESSION_ID }),
    [string]$ConfigPath = (Join-Path $env:USERPROFILE '.agora\config.json'),
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agora\state'),
    [string]$BunPath = (Get-Command bun.exe -ErrorAction Stop).Source,
    [string]$CodexPath = (Get-Command codex.exe -ErrorAction Stop).Source,
    [string]$LogPrefix = (Join-Path ([IO.Path]::GetTempPath()) 'agora-codex-watch'),
    [switch]$Worker
)

$ErrorActionPreference = 'Stop'
$agoraPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\bin\agora.mjs'))

if (-not $SessionId -or $SessionId -notmatch '^[A-Za-z0-9-]{8,128}$') {
    throw 'A Codex Desktop CODEX_THREAD_ID or CODEX_SESSION_ID is required.'
}

if ($Worker) {
    $env:AGORA_ACTOR = $Actor
    $env:CODEX_THREAD_ID = $SessionId
    $env:CODEX_SESSION_ID = $SessionId
    $env:AGORA_CONFIG = $ConfigPath
    $env:AGORA_STATE = $StateRoot
    $env:PATH = @((Split-Path $CodexPath), (Split-Path $BunPath), $env:PATH) -join ';'
    Remove-Item Env:AGORA_SESSION -ErrorAction SilentlyContinue

    $stdoutPath = "$LogPrefix.stdout.log"
    $stderrPath = "$LogPrefix.stderr.log"
    & $BunPath $agoraPath watch $Room --stream --follow --json --wake addressed --codex-queue 1>> $stdoutPath 2>> $stderrPath
    exit $LASTEXITCODE
}

function ConvertTo-ProcessArgument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
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
    '-ConfigPath', $ConfigPath,
    '-StateRoot', $StateRoot,
    '-BunPath', $BunPath,
    '-CodexPath', $CodexPath,
    '-LogPrefix', $LogPrefix
)
$commandLine = (ConvertTo-ProcessArgument $pwshPath) + ' ' + (($workerArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = (Get-Location).Path
}

if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
    throw "Win32_Process.Create failed with return code $($created.ReturnValue)."
}

[pscustomobject]@{
    supervisorPid = [int]$created.ProcessId
    room = $Room
    actor = $Actor
    session = $SessionId
    stdout = "$LogPrefix.stdout.log"
    stderr = "$LogPrefix.stderr.log"
} | ConvertTo-Json -Compress
