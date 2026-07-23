$ErrorActionPreference = "Stop"

$requiredEnvironment = @(
    "DATABASE_URL",
    "ASSISTANT_SECRET_KEY",
    "SENSITIVE_DATA_KEY",
    "EVIDENCE_MASTER_KEY"
)

foreach ($name in $requiredEnvironment + @(
    "DATABASE_SSLMODE",
    "DATABASE_CONN_MAX_AGE",
    "DATABASE_CONNECT_TIMEOUT",
    "ASSISTANT_DEBUG",
    "ALLOW_DERIVED_DATA_KEYS",
    "SENSITIVE_DATA_KEY_FALLBACKS"
)) {
    $value = [Environment]::GetEnvironmentVariable($name, "User")
    if ($value) {
        Set-Item -Path "Env:$name" -Value $value
    }
}

foreach ($name in $requiredEnvironment) {
    if (-not (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value) {
        throw "Missing required user environment variable: $name"
    }
}

if ($env:DATABASE_URL -notmatch '^postgres(ql)?://') {
    throw "DATABASE_URL must point to PostgreSQL"
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Project Python was not found at .venv\Scripts\python.exe; create the virtual environment and install requirements first"
}

$existingListener = Get-NetTCPConnection -LocalPort 18080 -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:18080/ready" -TimeoutSec 5
        if ($response.ok -eq $true -and $response.database.engine -eq "postgresql" -and
            $response.database.writable -eq $true -and $response.database.migrations_applied -eq $true) {
            return
        }
    } catch {
        throw "Port 18080 is occupied by a process that is not a healthy assistant service"
    }
    throw "Port 18080 is occupied by a process that is not a healthy assistant service"
}

Set-Location $projectRoot

& $python manage.py migrate --noinput
if ($LASTEXITCODE -ne 0) {
    throw "Database migration failed"
}

& $python -m waitress --listen=127.0.0.1:18080 config.wsgi:application
