$ErrorActionPreference = "Stop"

$keyPath = Join-Path $env:LOCALAPPDATA "HNAlarmAssistant\collector-key.dpapi"
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    throw "Collector key is not initialized: $keyPath"
}

$existing = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 17321 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    throw "Port 17321 is already in use"
}

$protectedKey = (Get-Content -LiteralPath $keyPath -Raw).Trim()
$secureKey = ConvertTo-SecureString $protectedKey
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $env:COLLECTOR_DATA_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $node = Get-Command node -ErrorAction Stop
    $process = Start-Process -FilePath $node.Source -ArgumentList @("collector-server.mjs") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    [pscustomobject]@{ Started = $true; ProcessId = $process.Id; KeyPath = $keyPath }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    Remove-Item Env:COLLECTOR_DATA_KEY -ErrorAction SilentlyContinue
}
