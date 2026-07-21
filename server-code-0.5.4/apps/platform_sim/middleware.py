import json
import logging
import time
import uuid

logger = logging.getLogger("sandbox.requests")


class RequestIdMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        started = time.perf_counter()
        response = self.get_response(request)
        response["X-Request-ID"] = request.request_id
        response["Cache-Control"] = "no-store"
        logger.info(json.dumps({
            "request_id": request.request_id,
            "method": request.method,
            "path": request.path,
            "status": response.status_code,
            "duration_ms": round((time.perf_counter() - started) * 1000),
        }, ensure_ascii=False))
        return response
