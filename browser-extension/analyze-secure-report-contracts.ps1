$ErrorActionPreference = "Stop"

$keyPath = Join-Path $env:LOCALAPPDATA "HNAlarmAssistant\collector-key.dpapi"
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    throw "Collector key is not initialized: $keyPath"
}

$protectedKey = (Get-Content -LiteralPath $keyPath -Raw).Trim()
$secureKey = ConvertTo-SecureString $protectedKey
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $env:COLLECTOR_DATA_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $env:DATA_DIR = Join-Path $PSScriptRoot "collector-data"
    $env:OUTPUT_PATH = Join-Path $PSScriptRoot "contract-summary.local.json"
    & node (Join-Path $PSScriptRoot "analyze-collector-contracts.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Contract analysis failed" }
    $env:INPUT_PATH = $env:OUTPUT_PATH
    $env:OUTPUT_PATH = Join-Path $PSScriptRoot "report-contract-candidates.local.json"
    & node (Join-Path $PSScriptRoot "build-report-contract-candidates.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Report contract candidate build failed" }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    Remove-Item Env:COLLECTOR_DATA_KEY,Env:DATA_DIR,Env:INPUT_PATH,Env:OUTPUT_PATH -ErrorAction SilentlyContinue
}
