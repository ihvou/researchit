function clean(value) {
  return String(value || "").trim();
}

function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (input) => {
    if (Array.isArray(input)) return input.map((item) => walk(item));
    if (input && typeof input === "object") {
      if (seen.has(input)) return null;
      seen.add(input);
      const out = {};
      Object.keys(input).sort().forEach((key) => {
        out[key] = walk(input[key]);
      });
      return out;
    }
    if (input == null) return null;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "string") return clean(input);
    if (typeof input === "boolean") return input;
    return String(input);
  };
  return JSON.stringify(walk(value));
}

function hashValue(value = {}) {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const LOCAL_CACHE = (() => {
  if (!globalThis.__RESEARCHIT_STAGE_CACHE__) {
    globalThis.__RESEARCHIT_STAGE_CACHE__ = new Map();
  }
  return globalThis.__RESEARCHIT_STAGE_CACHE__;
})();

function localKey(runId, stageId) {
  return `${clean(runId)}::${clean(stageId)}`;
}

async function requestStageCache(payload, method = "POST") {
  const res = await fetch("/api/account/stage-cache", {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data?.error || `Stage cache request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

function localGet(runId, stageId, hashInputs = {}) {
  const key = localKey(runId, stageId);
  const stored = LOCAL_CACHE.get(key);
  const hash = hashValue(hashInputs);
  if (!stored) {
    return {
      cacheHit: false,
      missReason: "no_entry",
      cacheKey: key,
      hash,
      hashInputs,
      cacheAgeMs: 0,
      output: null,
    };
  }
  if (clean(stored.hash) !== clean(hash)) {
    return {
      cacheHit: false,
      missReason: "hash_mismatch",
      cacheKey: key,
      hash,
      hashInputs,
      cacheAgeMs: 0,
      output: null,
    };
  }
  const storedAt = Number(stored?.storedAtMs || 0);
  return {
    cacheHit: true,
    missReason: null,
    cacheKey: key,
    hash,
    hashInputs,
    cacheAgeMs: storedAt > 0 ? Math.max(0, Date.now() - storedAt) : 0,
    output: stored?.output && typeof stored.output === "object" ? stored.output : null,
  };
}

function localSet(runId, stageId, hashInputs = {}, output = null) {
  const key = localKey(runId, stageId);
  const hash = hashValue(hashInputs);
  LOCAL_CACHE.set(key, {
    hash,
    hashInputs,
    output: output && typeof output === "object" ? output : null,
    storedAtMs: Date.now(),
  });
  return {
    ok: true,
    cacheKey: key,
    hash,
    bytes: JSON.stringify(output || {}).length,
  };
}

function localClearRun(runId) {
  const prefix = `${clean(runId)}::`;
  let deleted = 0;
  [...LOCAL_CACHE.keys()].forEach((key) => {
    if (!key.startsWith(prefix)) return;
    LOCAL_CACHE.delete(key);
    deleted += 1;
  });
  return { ok: true, deleted };
}

export function createStageCacheClient() {
  return {
    async get({ runId, stageId, hashInputs }) {
      try {
        const data = await requestStageCache({
          action: "get",
          runId,
          stageId,
          hashInputs,
        }, "POST");
        if (data && data.ok) return data;
      } catch (err) {
        if ([401, 403].includes(Number(err?.status || 0))) {
          return localGet(runId, stageId, hashInputs);
        }
        return {
          ...localGet(runId, stageId, hashInputs),
          missReason: "cache_unavailable",
          error: clean(err?.message),
        };
      }
      return localGet(runId, stageId, hashInputs);
    },
    async set({ runId, stageId, hashInputs, output, ttlSeconds }) {
      try {
        const data = await requestStageCache({
          action: "set",
          runId,
          stageId,
          hashInputs,
          output,
          ttlSeconds,
        }, "POST");
        if (data && data.ok) return data;
      } catch (err) {
        if ([401, 403].includes(Number(err?.status || 0))) {
          return localSet(runId, stageId, hashInputs, output);
        }
        return {
          ...localSet(runId, stageId, hashInputs, output),
          warning: clean(err?.message),
        };
      }
      return localSet(runId, stageId, hashInputs, output);
    },
    async clearRun(runId) {
      try {
        const data = await requestStageCache({ runId }, "DELETE");
        if (data && data.ok) return data;
      } catch (err) {
        if ([401, 403].includes(Number(err?.status || 0))) {
          return localClearRun(runId);
        }
        return {
          ...localClearRun(runId),
          warning: clean(err?.message),
        };
      }
      return localClearRun(runId);
    },
  };
}

