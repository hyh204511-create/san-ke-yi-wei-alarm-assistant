import base64
import os
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("SANDBOX_SECRET_KEY", "local-sandbox-only-not-for-production")
DEBUG = os.environ.get("SANDBOX_DEBUG", "1") == "1"
ENABLE_SIMULATION_ROUTES = DEBUG
if not DEBUG and SECRET_KEY == "local-sandbox-only-not-for-production":
    raise RuntimeError("Production mode requires a dedicated SANDBOX_SECRET_KEY")
if not DEBUG and (len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 5):
    raise RuntimeError("Production SANDBOX_SECRET_KEY must be at least 50 characters and sufficiently random")
ALLOW_DERIVED_DATA_KEYS = os.environ.get(
    "ALLOW_DERIVED_DATA_KEYS",
    "1" if DEBUG else "0",
) == "1"
ALLOWED_HOSTS = [item.strip() for item in os.environ.get("SANDBOX_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if item.strip()]
CSRF_TRUSTED_ORIGINS = [item.strip() for item in os.environ.get("SANDBOX_CSRF_TRUSTED_ORIGINS", "").split(",") if item.strip()]
if not DEBUG and (not ALLOWED_HOSTS or ALLOWED_HOSTS == ["127.0.0.1", "localhost"]):
    raise RuntimeError("Production SANDBOX_ALLOWED_HOSTS must name the deployed host")
if not DEBUG and not CSRF_TRUSTED_ORIGINS:
    raise RuntimeError("Production SANDBOX_CSRF_TRUSTED_ORIGINS must contain the HTTPS origin")


def _validate_production_key(name):
    encoded = os.environ.get(name, "").strip()
    try:
        decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"Production {name} must be URL-safe base64") from exc
    if len(decoded) != 32:
        raise RuntimeError(f"Production {name} must decode to exactly 32 bytes")


if not DEBUG:
    _validate_production_key("SENSITIVE_DATA_KEY")
    _validate_production_key("EVIDENCE_MASTER_KEY")

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "apps.governance",
    "apps.rule_governance",
    "apps.response_governance",
    "apps.disposals",
    "apps.reporting",
    "apps.evidence",
    "apps.platform_sim",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.platform_sim.middleware.RequestIdMiddleware",
]

ROOT_URLCONF = "config.urls"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
    ]},
}]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
if DATABASE_URL:
    parsed_database = urlparse(DATABASE_URL)
    if parsed_database.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("DATABASE_URL must use postgres:// or postgresql://")
    database_sslmode = os.environ.get("DATABASE_SSLMODE", "").strip().lower()
    if not DEBUG and database_sslmode not in {"require", "verify-ca", "verify-full"}:
        raise RuntimeError("Production DATABASE_SSLMODE must be require, verify-ca, or verify-full")
    DATABASES = {"default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": parsed_database.path.lstrip("/"),
        "USER": parsed_database.username or "",
        "PASSWORD": parsed_database.password or "",
        "HOST": parsed_database.hostname or "localhost",
        "PORT": str(parsed_database.port or 5432),
        "CONN_MAX_AGE": int(os.environ.get("DATABASE_CONN_MAX_AGE", "60")),
        "OPTIONS": {
            "connect_timeout": int(os.environ.get("DATABASE_CONNECT_TIMEOUT", "5")),
            **({"sslmode": database_sslmode} if database_sslmode else {}),
        },
    }}
elif not DEBUG:
    raise RuntimeError("Production mode requires DATABASE_URL for PostgreSQL")
else:
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "sandbox.sqlite3"}}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_I18N = True
USE_TZ = True

SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_HSTS_SECONDS = int(os.environ.get("SANDBOX_SECURE_HSTS_SECONDS", "0" if DEBUG else "31536000"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = os.environ.get("SANDBOX_SECURE_HSTS_INCLUDE_SUBDOMAINS", "1" if not DEBUG else "0") == "1"
SECURE_HSTS_PRELOAD = os.environ.get("SANDBOX_SECURE_HSTS_PRELOAD", "1" if not DEBUG else "0") == "1"
LOGIN_URL = "/assistant/login"
LOGIN_REDIRECT_URL = "/assistant/"
LOGOUT_REDIRECT_URL = "/assistant/login"
REPORT_EXPORT_DIR = os.environ.get("REPORT_EXPORT_DIR", str(BASE_DIR / "report-exports"))
EVIDENCE_EXPORT_DIR = os.environ.get("EVIDENCE_EXPORT_DIR", str(BASE_DIR / "evidence-exports"))
DATA_RETENTION_DAYS = int(os.environ.get("DATA_RETENTION_DAYS", "365"))
REPORT_EXPORT_RETENTION_DAYS = int(os.environ.get("REPORT_EXPORT_RETENTION_DAYS", "7"))
SECURE_SSL_REDIRECT = os.environ.get("SANDBOX_SECURE_SSL_REDIRECT", "0" if DEBUG else "1") == "1"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
