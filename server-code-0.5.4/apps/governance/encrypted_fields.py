import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.db import models


PREFIX = "enc:v1:"


def _decode_key(encoded, setting_name):
    try:
        key = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except (ValueError, TypeError) as exc:
        raise ImproperlyConfigured(f"{setting_name} must be URL-safe base64") from exc
    if len(key) != 32:
        raise ImproperlyConfigured(f"{setting_name} must decode to exactly 32 bytes")
    return key


def sensitive_data_keys():
    encoded = os.environ.get("SENSITIVE_DATA_KEY", "").strip()
    if encoded:
        primary = _decode_key(encoded, "SENSITIVE_DATA_KEY")
    elif settings.ALLOW_DERIVED_DATA_KEYS:
        primary = hashlib.sha256((settings.SECRET_KEY + ":local-sensitive-data").encode("utf-8")).digest()
    else:
        raise ImproperlyConfigured("SENSITIVE_DATA_KEY is required when derived data keys are disabled")
    keys = [primary]
    for index, fallback in enumerate(os.environ.get("SENSITIVE_DATA_KEY_FALLBACKS", "").split(","), start=1):
        fallback = fallback.strip()
        if not fallback:
            continue
        key = _decode_key(fallback, f"SENSITIVE_DATA_KEY_FALLBACKS item {index}")
        if key not in keys:
            keys.append(key)
    return tuple(keys)


def sensitive_data_key():
    return sensitive_data_keys()[0]


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
    except Exception as exc:
        raise ValidationError("Sensitive JSON integrity verification failed") from exc
    last_error = None
    for key in sensitive_data_keys():
        try:
            raw = AESGCM(key).decrypt(packed[:12], packed[12:], b"assistant-sensitive-json-v1")
            return json.loads(raw.decode("utf-8"))
        except Exception as exc:
            last_error = exc
    raise ValidationError("Sensitive JSON integrity verification failed") from last_error


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

    def value_to_string(self, obj):
        value = self.value_from_object(obj)
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

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
