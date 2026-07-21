import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.db import models


PREFIX = "enc:v1:"


def sensitive_data_key():
    encoded = os.environ.get("SENSITIVE_DATA_KEY", "").strip()
    if encoded:
        try:
            key = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        except ValueError as exc:
            raise ImproperlyConfigured("SENSITIVE_DATA_KEY must be URL-safe base64") from exc
        if len(key) != 32:
            raise ImproperlyConfigured("SENSITIVE_DATA_KEY must decode to exactly 32 bytes")
        return key
    if settings.ALLOW_DERIVED_DATA_KEYS:
        return hashlib.sha256((settings.SECRET_KEY + ":local-sensitive-data").encode("utf-8")).digest()
    raise ImproperlyConfigured("SENSITIVE_DATA_KEY is required when derived data keys are disabled")


def encrypt_json(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    nonce = os.urandom(12)
    ciphertext = AESGCM(sensitive_data_key()).encrypt(nonce, raw, b"assistant-sensitive-json-v1")
    return PREFIX + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def decrypt_json(value):
    if value is None or value == "":
        return None
    if isinstance(value, (dict, list, int, float, bool)):
        return value
    text = str(value)
    if not text.startswith(PREFIX):
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValidationError("Legacy sensitive JSON value is invalid") from exc
    try:
        packed = base64.urlsafe_b64decode(text[len(PREFIX):])
        raw = AESGCM(sensitive_data_key()).decrypt(packed[:12], packed[12:], b"assistant-sensitive-json-v1")
        return json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValidationError("Sensitive JSON integrity verification failed") from exc


class EncryptedJSONField(models.TextField):
    description = "AES-256-GCM encrypted JSON"

    def __init__(self, *args, default=dict, **kwargs):
        super().__init__(*args, default=default, **kwargs)

    def from_db_value(self, value, expression, connection):
        return decrypt_json(value)

    def to_python(self, value):
        if value is None or isinstance(value, (dict, list, int, float, bool)):
            return value
        return decrypt_json(value)

    def get_prep_value(self, value):
        value = super().get_prep_value(value)
        if value is None:
            return None
        if isinstance(value, str) and value.startswith(PREFIX):
            return value
        if isinstance(value, str):
            try: value = json.loads(value)
            except json.JSONDecodeError: pass
        return encrypt_json(value)
