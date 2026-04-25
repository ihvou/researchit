import { callActorJson, clean, ensureArray } from "./common.js";

export const CRITIC_COMPACT_RETRY_REASON = "critic_compact_retry_used";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function serializeBoundedJsonArray(items = [], maxChars = 26000) {
  const budget = Math.max(1000, Number(maxChars) || 26000);
  const input = ensureArray(items);
  const selected = [];
  let omitted = 0;
  let json = "[]";

  input.forEach((item) => {
    const candidate = JSON.stringify([...selected, item]);
    if (candidate.length <= budget || selected.length === 0) {
      selected.push(item);
      json = candidate;
    } else {
      omitted += 1;
    }
  });

  let validJsonSnapshot = true;
  try {
    JSON.parse(json);
  } catch (_) {
    validJsonSnapshot = false;
  }

  return {
    json,
    items: selected,
    diagnostics: {
      selectedUnits: selected.length,
      omittedUnits: omitted,
      totalUnits: input.length,
      serializedChars: json.length,
      validJsonSnapshot,
    },
  };
}

export function isCriticRateLimitError(err = {}) {
  const status = Number(err?.status || err?.statusCode || 0);
  const message = clean(err?.message).toLowerCase();
  return status === 429 || message.includes("rate limit") || /\b429\b/.test(message);
}

export function isCriticTimeoutError(err = {}) {
  const status = Number(err?.status || err?.statusCode || 0);
  const code = clean(err?.code).toLowerCase();
  const message = clean(err?.message).toLowerCase();
  const source = clean(err?.abortReason?.source).toLowerCase();
  const streamEvent = clean(err?.streamEvent).toLowerCase();
  const providerEventType = clean(err?.providerEventType || err?.type).toLowerCase();
  return (
    status === 504
    || status === 408
    || code.includes("timeout")
    || code === "provider_timeout"
    || source === "provider_timeout"
    || source === "stage_timeout"
    || streamEvent === "error"
    || providerEventType.endsWith("_error")
    || providerEventType === "error"
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("/api/critic (504)")
  );
}

async function waitForRateLimit(err = {}, stageBudget = {}) {
  const retryAfterMs = Number(err?.retryAfterMs || 0);
  const skewMs = Math.max(0, Number(stageBudget?.rateLimitRetrySkewMs || 1500));
  const initialMs = Math.max(1000, Number(stageBudget?.rateLimitInitialBackoffMs || 15000));
  const maxMs = Math.max(initialMs, Number(stageBudget?.rateLimitMaxBackoffMs || (12 * 60 * 1000)));
  const waitMs = Math.min(maxMs, Math.max(initialMs, retryAfterMs > 0 ? retryAfterMs + skewMs : 0));
  await sleep(waitMs);
}

export async function callCriticJsonWithFallback({
  state,
  runtime,
  stageId,
  systemPrompt,
  primaryPrompt,
  compactPrompt,
  tokenBudget = 8000,
  timeoutMs = 75000,
  liveSearch = true,
  searchMaxUses = 3,
  schemaHint = "",
} = {}) {
  const stageBudget = runtime?.budgets?.[stageId] || {};
  const base = {
    state,
    runtime,
    stageId,
    actor: "critic",
    systemPrompt,
    tokenBudget,
    timeoutMs,
    maxRetries: 0,
    liveSearch,
    searchMaxUses,
    schemaHint,
    allowCompaction: false,
  };
  const attempts = [];
  let usedCompactRetry = false;

  const runCall = async (prompt, mode) => {
    attempts.push(mode);
    return callActorJson({
      ...base,
      userPrompt: prompt,
    });
  };

  try {
    return {
      result: await runCall(primaryPrompt, "primary"),
      usedCompactRetry,
      attempts,
    };
  } catch (firstErr) {
    if (isCriticRateLimitError(firstErr)) {
      await waitForRateLimit(firstErr, stageBudget);
      try {
        return {
          result: await runCall(primaryPrompt, "primary_rate_limit_retry"),
          usedCompactRetry,
          attempts,
        };
      } catch (secondErr) {
        if (!isCriticTimeoutError(secondErr)) throw secondErr;
      }
    } else if (!isCriticTimeoutError(firstErr)) {
      throw firstErr;
    }
  }

  usedCompactRetry = true;
  try {
    return {
      result: await runCall(compactPrompt, "compact"),
      usedCompactRetry,
      attempts,
    };
  } catch (compactErr) {
    if (!isCriticRateLimitError(compactErr)) throw compactErr;
    await waitForRateLimit(compactErr, stageBudget);
    return {
      result: await runCall(compactPrompt, "compact_rate_limit_retry"),
      usedCompactRetry,
      attempts,
    };
  }
}
