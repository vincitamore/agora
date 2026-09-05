param([Parameter(Mandatory)][string]$NodePath,[Parameter(Mandatory)][string]$WorkerPath,[Parameter(Mandatory)][string]$OfferDirectory)
$ErrorActionPreference='Stop'
function Quote-Argument([string]$Value) {
    '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}
$arguments=@($NodePath,$WorkerPath,'--offer-worker',$OfferDirectory)
$line=($arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line;ProcessStartupInformation=$startup}
if($result.ReturnValue -ne 0){throw 'Could not start the resident Agora offer worker.'}
