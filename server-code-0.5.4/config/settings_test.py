import os

os.environ["ASSISTANT_DEBUG"] = "1"
os.environ["DATABASE_URL"] = "postgresql://test:test@127.0.0.1/test"

from .settings import *  # noqa: F403,E402

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
