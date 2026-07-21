from django.core import signing

from .services import GovernanceError


TOKEN_SALT = "assistant-action-token"
TOKEN_MAX_AGE_SECONDS = 300


def issue_action_token(request):
    if not request.session.session_key:
        request.session.save()
    return signing.dumps({"userId": request.user.pk, "sessionKey": request.session.session_key}, salt=TOKEN_SALT, compress=True)


def verify_action_token(request):
    token = request.headers.get("X-Assistant-Action-Token", "")
    try:
        signed = signing.loads(token, salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE_SECONDS)
    except signing.BadSignature as exc:
        raise GovernanceError("操作令牌无效或已过期", "ACTION_TOKEN_REQUIRED", 403) from exc
    if signed.get("userId") != request.user.pk or signed.get("sessionKey") != request.session.session_key:
        raise GovernanceError("操作令牌与当前实名会话不匹配", "ACTION_TOKEN_MISMATCH", 403)
    return signed
