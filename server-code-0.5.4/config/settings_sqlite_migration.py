import os
from pathlib import Path

source = os.environ.get("SQLITE_MIGRATION_SOURCE", "").strip()
if not source:
    raise RuntimeError("SQLITE_MIGRATION_SOURCE must be an absolute path to the offline SQLite source")
source_path = Path(source)
if not source_path.is_absolute() or source_path.name == ":memory:":
    raise RuntimeError("SQLITE_MIGRATION_SOURCE must be an absolute file path")
if not source_path.is_file():
    raise RuntimeError("SQLITE_MIGRATION_SOURCE does not exist")

os.environ["ASSISTANT_DEBUG"] = "1"
os.environ["DATABASE_URL"] = "postgresql://offline:offline@127.0.0.1/offline"

from .settings import *  # noqa: F403,E402

DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": source_path}}
