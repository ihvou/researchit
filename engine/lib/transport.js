function ensureFunction(callFn) {
  if (typeof callFn !== "function") {
    throw new Error("createTransport requires a callFn(role, payload) function");
  }
}

export const DEFAULT_RETRYABLE_STATUS = [408, 409, 425, 429, 500, 502, 503, 504];
const DEFAULT_POLICY_BY_ROLE = {
  analyst: {
    timeoutMs: 55000,
    maxRetries: 2,
    initialBackoffMs: 300,
    maxBackoffMs: 2500,
    backoffFactor: 2,
    retryableStatus: DEFAULT_RETRYABLE_STATUS,
  },
  critic: {
    timeoutMs: 55000,
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
  let timer = null;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeError(err) {
  if (err instanceof Error) return err;
  const wrapped = new Error(String(err || "Unknown transport error"));
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

function retryBackoffMs(attempt, policy) {
  const base = clampNumber(policy.initialBackoffMs, 250);
  const factor = clampNumber(policy.backoffFactor, 2, 1);
  const max = clampNumber(policy.maxBackoffMs, 2500);
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
    throw new Error(data.error);
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
        () => callFn(role, payload),
        policy.timeoutMs,
        `${role} request`
      );
      return normalizeResult(data, includeMeta);
    } catch (rawErr) {
      const err = normalizeError(rawErr);
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
      await sleep(retryBackoffMs(attempt, policy));
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

    async fetchSource(url, options = {}) {
      const policy = resolvePolicy("fetchSource", transportOptions, options);
      const data = await callWithRetry({
        role: "fetch-source",
        payload: { url },
        includeMeta: true,
        callFn,
        policy,
      });
      if (data?.error) throw new Error(data.error);
      return data;
    },
  };
}
