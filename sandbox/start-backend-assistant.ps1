[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$sandboxRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 18080

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    exit 0
}

$python = (Get-Command python.exe -ErrorAction Stop).Source
Set-Location -LiteralPath $sandboxRoot
& $python manage.py runserver 127.0.0.1:18080 --noreload
