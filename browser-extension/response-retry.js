export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxRetries: 2,
  delaysMs: Object.freeze([5_000, 10_000]),
  retryOn: Object.freeze(["FAILED"]),
  maxDurationMs: 30_000,
});

export function normalizeRetryPolicy(value) {
  const maxRetries = Number.isInteger(value?.maxRetries)
    ? Math.max(0, Math.min(value.maxRetries, 2))
    : DEFAULT_RETRY_POLICY.maxRetries;
  const delaysMs = Array.isArray(value?.delaysMs)
    ? value.delaysMs.slice(0, maxRetries).map(Number)
    : [...DEFAULT_RETRY_POLICY.delaysMs].slice(0, maxRetries);
  const validDelays = delaysMs.length === maxRetries
    && delaysMs.every((delay) => Number.isInteger(delay) && delay >= 1_000 && delay <= 120_000);
  const retryOn = Array.isArray(value?.retryOn) && value.retryOn.length
    ? [...new Set(value.retryOn.filter((status) => status === "FAILED"))]
    : [...DEFAULT_RETRY_POLICY.retryOn];
  return {
    maxRetries,
    delaysMs: validDelays ? delaysMs : [...DEFAULT_RETRY_POLICY.delaysMs].slice(0, maxRetries),
    retryOn: retryOn.length ? retryOn : [...DEFAULT_RETRY_POLICY.retryOn],
    maxDurationMs: Number.isInteger(value?.maxDurationMs) && value.maxDurationMs >= 1_000
      ? Math.min(value.maxDurationMs, 30_000) : DEFAULT_RETRY_POLICY.maxDurationMs,
  };
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function executeWithRetry(execute, policyValue, { waitFn = wait } = {}) {
  const policy = normalizeRetryPolicy(policyValue);
  const deliveries = [];
  const startedAt = Date.now();
  for (let index = 0; index <= policy.maxRetries; index += 1) {
    if (Date.now() - startedAt >= policy.maxDurationMs) break;
    const result = await execute(index + 1);
    deliveries.push({ ...result, attemptNumber: index + 1 });
    if (result.status === "SUCCEEDED") break;
    if (!policy.retryOn.includes(result.status) || index >= policy.maxRetries) break;
    if (Date.now() - startedAt + policy.delaysMs[index] >= policy.maxDurationMs) break;
    await waitFn(policy.delaysMs[index]);
  }
  const final = deliveries.at(-1) || { status: "FAILED", error: "响应渠道没有返回结果" };
  return {
    ...final,
    deliveries,
    retryCount: Math.max(0, deliveries.length - 1),
    retryPolicy: policy,
  };
}
