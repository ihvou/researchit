import { attachAbortReason, normalizeAbortReason } from "./abort-reason.js";

function ensureFunction(callFn) {
  if (typeof callFn !== "function") {
    throw new Error("createTransport requires a callFn(role, payload) function");
  }
}

export const DEFAULT_RETRYABLE_STATUS = [408, 409, 425, 429, 500, 502, 503, 504];
const DEFAULT_POLICY_BY_ROLE = {
  analyst: {
    timeoutMs: 180000,
    maxRetries: 2,
    initialBackoffMs: 300,
    maxBackoffMs: 2500,
    backoffFactor: 2,
    retryableStatus: DEFAULT_RETRYABLE_STATUS,
  },
  critic: {
    timeoutMs: 120000,
    maxRetries: 2,
    initialBackoffMs: 300,
    maxBackoffMs: 2500,
    backoffFactor: 2,
    retryableStatus: DEFAULT_RETRYABLE_STATUS,
  },
  fetchSource: {
    timeoutMs: 12000,
    maxRetries: 1,
    initialBackoffMs: 150,
    maxBackoffMs: 800,
    backoffFactor: 2,
    retryableStatus: DEFAULT_RETRYABLE_STATUS,
  },
};

function clampNumber(value, fallback, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
}

function timeoutError(label, timeoutMs) {
  const err = new Error(`${label} timed out after ${Math.round(timeoutMs)}ms`);
  err.code = "TIMEOUT";
  err.retryable = true;
  return err;
}

async function withTimeout(fn, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fn();
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const onTimeout = () => {
    timedOut = true;
    try {
      controller.abort({
        source: "provider_timeout",
        layer: "transport_timeout",
        deadlineMs: timeoutMs,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (_) {
      // no-op
    }
  };
  const timer = setTimeout(onTimeout, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    const abortReason = normalizeAbortReason(
      err?.abortReason || controller?.signal?.reason,
      timedOut ? "provider_timeout" : "unknown"
    );
    if (timedOut || String(err?.name || "").toLowerCase() === "aborterror") {
      const timeoutErr = timeoutError(label, timeoutMs);
      attachAbortReason(timeoutErr, abortReason, timedOut ? "provider_timeout" : "unknown");
      throw timeoutErr;
    }
    attachAbortReason(err instanceof Error ? err : new Error(String(err || "Abort error")), abortReason, "unknown");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeError(err) {
  if (err instanceof Error) return err;
  const wrapped = new Error(String(err || "Unknown transport error"));
  if (err?.abortReason) {
    wrapped.abortReason = normalizeAbortReason(err.abortReason, "unknown");
  }
  return wrapped;
}

function extractStatus(err) {
  const direct = Number(err?.status || err?.statusCode || err?.codeNumber);
  if (Number.isFinite(direct) && direct >= 100) return direct;
  const msg = String(err?.message || "");
  const match = msg.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

function isRetryableError(err, policy) {
  if (!err) return false;
  if (err.retryable === true) return true;
  const status = extractStatus(err);
  if (status && Array.isArray(policy.retryableStatus) && policy.retryableStatus.includes(status)) {
    return true;
  }
  const msg = String(err.message || "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("timeout")
    || msg.includes("timed out")
    || msg.includes("network")
    || msg.includes("temporar")
    || msg.includes("rate limit")
    || msg.includes("fetch failed")
    || msg.includes("econnreset")
    || msg.includes("ehostunreach")
    || msg.includes("enotfound")
  );
}

function retryBackoffMs(attempt, policy, err = null) {
  const base = clampNumber(policy.initialBackoffMs, 250);
  const factor = clampNumber(policy.backoffFactor, 2, 1);
  const max = clampNumber(policy.maxBackoffMs, 2500);
  const msg = String(err?.message || "").toLowerCase();
  const status = extractStatus(err);
  const isRateLimit = status === 429 || msg.includes("rate limit");
  if (isRateLimit) {
    const rateBase = clampNumber(policy.rateLimitInitialBackoffMs, Math.max(base, 10000));
    const rateFactor = clampNumber(policy.rateLimitBackoffFactor, 1.7, 1);
    const rateMax = clampNumber(policy.rateLimitMaxBackoffMs, Math.max(max, 60000));
    const rateExp = rateBase * (rateFactor ** Math.max(0, attempt - 1));
    const rateJitter = 0.9 + (Math.random() * 0.2);
    return Math.min(rateMax, rateExp) * rateJitter;
  }
  const exp = base * (factor ** Math.max(0, attempt - 1));
  const jitter = 0.85 + (Math.random() * 0.3);
  return Math.min(max, exp) * jitter;
}

function resolvePolicy(roleKey, transportOptions = {}, callOptions = {}) {
  const defaults = DEFAULT_POLICY_BY_ROLE[roleKey] || DEFAULT_POLICY_BY_ROLE.analyst;
  const shared = transportOptions?.retry || {};
  const scoped = shared?.[roleKey] && typeof shared[roleKey] === "object"
    ? shared[roleKey]
    : shared;

  const callRetry = callOptions?.retry;
  const perCall = (callRetry && typeof callRetry === "object") ? callRetry : {};
  const merged = {
    ...defaults,
    ...(scoped && typeof scoped === "object" ? scoped : {}),
    ...perCall,
  };

  if (callRetry === false) merged.maxRetries = 0;
  if (callOptions?.timeoutMs != null) merged.timeoutMs = callOptions.timeoutMs;

  merged.timeoutMs = clampNumber(merged.timeoutMs, defaults.timeoutMs);
  merged.maxRetries = clampNumber(merged.maxRetries, defaults.maxRetries);
  merged.initialBackoffMs = clampNumber(merged.initialBackoffMs, defaults.initialBackoffMs);
  merged.maxBackoffMs = clampNumber(merged.maxBackoffMs, defaults.maxBackoffMs);
  merged.backoffFactor = clampNumber(merged.backoffFactor, defaults.backoffFactor, 1);
  merged.retryableStatus = Array.isArray(merged.retryableStatus)
    ? merged.retryableStatus.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : defaults.retryableStatus;
  return merged;
}

function normalizeResult(data, includeMeta = false) {
  if (data?.error) {
    const err = new Error(String(data.error));
    err.status = Number(data?.status || 0) || undefined;
    err.reasonCode = String(data?.reasonCode || "").trim() || undefined;
    err.abortReason = data?.abortReason && typeof data.abortReason === "object"
      ? normalizeAbortReason(data.abortReason, "unknown")
      : undefined;
    throw err;
  }
  if (includeMeta) return data;
  return data?.text;
}

async function callWithRetry({
  role,
  payload,
  includeMeta = false,
  callFn,
  policy,
}) {
  let attempt = 0;
  let lastErr = null;
  const maxAttempts = Math.max(1, Number(policy.maxRetries || 0) + 1);

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const data = await withTimeout(
        (signal) => callFn(role, payload, { signal }),
        policy.timeoutMs,
        `${role} request`
      );
      return normalizeResult(data, includeMeta);
    } catch (rawErr) {
      const err = normalizeError(rawErr);
      if (err?.abortReason && typeof err.abortReason === "object") {
        err.abortReason = normalizeAbortReason(err.abortReason, "unknown");
      }
      lastErr = err;
      const retryable = isRetryableError(err, policy);
      const finalAttempt = attempt >= maxAttempts;
      if (!retryable || finalAttempt) {
        err.attempts = attempt;
        err.role = role;
        if (!err.message.includes("(attempt")) {
          err.message = `${err.message} (attempt ${attempt}/${maxAttempts})`;
        }
        throw err;
      }
      await sleep(retryBackoffMs(attempt, policy, err));
    }
  }

  if (lastErr) throw lastErr;
  throw new Error(`${role} request failed without an explicit error.`);
}

export function createTransport(callFn, transportOptions = {}) {
  ensureFunction(callFn);

  return {
    async callAnalyst(messages, systemPrompt, maxTokens = 5000, options = {}) {
      const payload = {
        messages,
        systemPrompt,
        maxTokens,
        liveSearch: !!options.liveSearch,
        deepResearch: !!options.deepResearch,
        stageId: typeof options.stageId === "string" ? options.stageId : undefined,
        provider: typeof options.provider === "string" ? options.provider : undefined,
        model: typeof options.model === "string" ? options.model : undefined,
        webSearchModel: typeof options.webSearchModel === "string" ? options.webSearchModel : undefined,
        baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
      };
      const policy = resolvePolicy("analyst", transportOptions, options);
      return callWithRetry({
        role: "analyst",
        payload,
        includeMeta: !!options.includeMeta,
        callFn,
        policy,
      });
    },

    async callCritic(messages, systemPrompt, maxTokens = 5000, options = {}) {
      const payload = {
        messages,
        systemPrompt,
        maxTokens,
        liveSearch: !!options.liveSearch,
        stageId: typeof options.stageId === "string" ? options.stageId : undefined,
        provider: typeof options.provider === "string" ? options.provider : undefined,
        model: typeof options.model === "string" ? options.model : undefined,
        webSearchModel: typeof options.webSearchModel === "string" ? options.webSearchModel : undefined,
        baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
      };
      const policy = resolvePolicy("critic", transportOptions, options);
      return callWithRetry({
        role: "critic",
        payload,
        includeMeta: !!options.includeMeta,
        callFn,
        policy,
      });
    },

    async callSynthesizer(messages, systemPrompt, maxTokens = 5000, options = {}) {
      const payload = {
        messages,
        systemPrompt,
        maxTokens,
        liveSearch: !!options.liveSearch,
        stageId: typeof options.stageId === "string" ? options.stageId : undefined,
        provider: typeof options.provider === "string" ? options.provider : undefined,
        model: typeof options.model === "string" ? options.model : undefined,
        webSearchModel: typeof options.webSearchModel === "string" ? options.webSearchModel : undefined,
        baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
      };
      const policy = resolvePolicy("analyst", transportOptions, options);
      return callWithRetry({
        role: "analyst",
        payload,
        includeMeta: !!options.includeMeta,
        callFn,
        policy,
      });
    },

    async fetchSource(url, options = {}) {
      const policy = resolvePolicy("fetchSource", transportOptions, options);
      const data = await callWithRetry({
        role: "fetch-source",
        payload: {
          url,
          resolveOnly: options?.resolveOnly === true,
        },
        includeMeta: true,
        callFn,
        policy,
      });
      if (data?.error) {
        const err = new Error(String(data.error));
        err.sourceFetchStatus = String(data?.sourceFetchStatus || "");
        err.resolvedUrl = String(data?.resolvedUrl || "");
        err.url = String(data?.url || url);
        throw err;
      }
      return data;
    },
  };
}
