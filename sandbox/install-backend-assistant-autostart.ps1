[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$taskName = "HN Alarm Assistant Backend"
$scriptPath = Join-Path $PSScriptRoot "start-backend-assistant.ps1"
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$userId = "$env:USERDOMAIN\$env:USERNAME"
$actionArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$action = New-ScheduledTaskAction -Execute $powershell -Argument $actionArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Start the local HN Alarm Assistant backend at user logon without storing credentials." `
    -Force | Out-Null

Write-Output "已为 $userId 注册任务：$taskName"
