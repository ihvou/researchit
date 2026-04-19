import { REASON_CODES } from "../../pipeline/contracts/reason-codes.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isRateLimitError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 429) return true;
  const message = String(err?.message || "").toLowerCase();
  return message.includes("rate limit") || message.includes("429");
}

function isTimeoutError(err) {
  const code = String(err?.code || "").toLowerCase();
  if (code.includes("timeout")) return true;
  const message = String(err?.message || "").toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

function classifyFailure(err) {
  const reasonCode = String(err?.reasonCode || "").trim();
  if (reasonCode === REASON_CODES.RESPONSE_PARSE_FAILED) return "parse";
  if (isRateLimitError(err)) return "rate_limit";
  if (isTimeoutError(err)) return "timeout";
  const message = String(err?.message || "").toLowerCase();
  if (message.includes("parse") || message.includes("json")) return "parse";
  return "other";
}

export async function executeWithRetry(work, options = {}) {
  const maxRetries = Math.max(0, Number(options?.maxRetries) || 0);
  const timeoutMs = Number(options?.timeoutMs) || 0;
  const initialBackoffMs = Math.max(20, Number(options?.initialBackoffMs) || 250);
  const backoffFactor = Math.max(1, Number(options?.backoffFactor) || 2);
  const onRetry = typeof options?.onRetry === "function" ? options.onRetry : null;

  let lastError = null;
  const attempts = maxRetries + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const start = Date.now();
    try {
      const maybePromise = Promise.resolve().then(() => work({ attempt }));
      let result;
      if (timeoutMs > 0) {
        result = await Promise.race([
          maybePromise,
          new Promise((_, reject) => {
            setTimeout(() => {
              const err = new Error(`stage timed out after ${Math.round(timeoutMs)}ms`);
              err.code = "STAGE_TIMEOUT";
              reject(err);
            }, timeoutMs);
          }),
        ]);
      } else {
        result = await maybePromise;
      }

      return {
        ok: true,
        result,
        attemptsUsed: attempt,
        durationMs: Date.now() - start,
        reasonCodes: [],
      };
    } catch (err) {
      lastError = err;
      const failureType = classifyFailure(err);
      const finalAttempt = attempt >= attempts;
      if (finalAttempt) {
        const reasonCodes = [];
        if (failureType === "rate_limit") {
          reasonCodes.push(REASON_CODES.RATE_LIMIT_BACKOFF_EXHAUSTED);
        } else if (failureType === "timeout") {
          reasonCodes.push(REASON_CODES.STAGE_TIMEOUT, REASON_CODES.RETRY_EXHAUSTED);
        } else if (failureType === "parse") {
          reasonCodes.push(REASON_CODES.RESPONSE_PARSE_FAILED);
        } else {
          reasonCodes.push(REASON_CODES.RETRY_EXHAUSTED);
        }
        return {
          ok: false,
          error: err,
          attemptsUsed: attempt,
          durationMs: Date.now() - start,
          reasonCodes,
        };
      }

      if (onRetry) {
        await onRetry({
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: attempts,
          error: err,
          failureType,
        });
      }

      const backoff = Math.min(5000, Math.round(initialBackoffMs * (backoffFactor ** (attempt - 1))));
      await sleep(backoff);
    }
  }

  return {
    ok: false,
    error: lastError || new Error("retry failed without explicit error"),
    attemptsUsed: attempts,
    durationMs: 0,
    reasonCodes: [REASON_CODES.RETRY_EXHAUSTED],
  };
}
