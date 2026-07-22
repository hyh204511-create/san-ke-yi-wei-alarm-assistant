export async function executeVoiceThenTextFallback(ordered, { execute, skip }) {
  const attempts = [];
  let stopForUnknown = false;
  let voiceExplicitlyFailed = false;
  for (const original of ordered) {
    if (stopForUnknown) {
      attempts.push(await skip(original, "前序语音结果未知或被阻断，禁止继续自动下发"));
      continue;
    }
    const attempt = await execute(original);
    attempts.push(attempt);
    if (original.channelType === "VOICE" && attempt.status === "FAILED") {
      voiceExplicitlyFailed = true;
      continue;
    }
    if (attempt.status !== "SUCCEEDED") stopForUnknown = true;
  }
  const textSucceeded = attempts.some(
    (attempt) => attempt.channelType === "TEXT" && attempt.status === "SUCCEEDED"
  );
  const fallbackUsed = voiceExplicitlyFailed && textSucceeded;
  return {
    attempts,
    fallbackUsed,
    failed: stopForUnknown || voiceExplicitlyFailed || !textSucceeded,
  };
}
