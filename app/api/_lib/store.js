import crypto from "node:crypto";

const KV_URL = String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const KV_TOKEN = String(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const KV_ENABLED = !!(KV_URL && KV_TOKEN);
const KV_LOCK_TTL_SECONDS = 8;
const KV_LOCK_WAIT_MS = 2400;

function isProductionEnv() {
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  return nodeEnv === "production" || vercelEnv === "production";
}

function getMemoryStore() {
  if (!globalThis.__RESEARCHIT_MEMORY_STORE__) {
    globalThis.__RESEARCHIT_MEMORY_STORE__ = new Map();
  }
  return globalThis.__RESEARCHIT_MEMORY_STORE__;
}

function getMemoryLocks() {
  if (!globalThis.__RESEARCHIT_MEMORY_LOCKS__) {
    globalThis.__RESEARCHIT_MEMORY_LOCKS__ = new Map();
  }
  return globalThis.__RESEARCHIT_MEMORY_LOCKS__;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeJsonValue(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function sleep(ms = 0) {
  const timeout = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

async function kvCommand(args = []) {
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`KV command failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const data = await res.json().catch(() => ({}));
  if (data?.error) {
    throw new Error(`KV error: ${data.error}`);
  }
  return data?.result;
}

async function withKvLock(lockKey, fn, options = {}) {
  const maxWaitMs = Math.max(300, Number(options?.maxWaitMs) || KV_LOCK_WAIT_MS);

  if (!KV_ENABLED) {
    const owner = crypto.randomUUID();
    const deadline = Date.now() + maxWaitMs;
    const locks = getMemoryLocks();
    while (Date.now() <= deadline) {
      if (!locks.has(lockKey)) {
        locks.set(lockKey, owner);
        try {
          return await fn();
        } finally {
          if (locks.get(lockKey) === owner) {
            locks.delete(lockKey);
          }
        }
      }
      await sleep(20 + Math.floor(Math.random() * 15));
    }
    const err = new Error("Storage is busy. Please retry.");
    err.code = "STORE_LOCK_TIMEOUT";
    throw err;
  }
  const ttlSeconds = Math.max(2, Number(options?.ttlSeconds) || KV_LOCK_TTL_SECONDS);
  const owner = crypto.randomUUID();
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() <= deadline) {
    const acquired = await kvCommand(["SET", lockKey, owner, "NX", "EX", ttlSeconds]);
    if (acquired === "OK" || acquired === true) {
      try {
        return await fn();
      } finally {
        try {
          const currentOwner = await kvCommand(["GET", lockKey]);
          if (String(currentOwner || "") === owner) {
            await kvCommand(["DEL", lockKey]);
          }
        } catch (_) {
          // Best-effort unlock only.
        }
      }
    }
    await sleep(70 + Math.floor(Math.random() * 50));
  }
  const err = new Error("Storage is busy. Please retry.");
  err.code = "STORE_LOCK_TIMEOUT";
  throw err;
}

async function getValue(key) {
  if (KV_ENABLED) {
    const result = await kvCommand(["GET", key]);
    return normalizeJsonValue(result);
  }
  const store = getMemoryStore();
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return normalizeJsonValue(entry.value);
}

async function setValue(key, value, options = {}) {
  const payload = JSON.stringify(value ?? null);
  const ttlSeconds = Number(options?.ttlSeconds);
  if (KV_ENABLED) {
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      await kvCommand(["SET", key, payload, "EX", Math.floor(ttlSeconds)]);
    } else {
      await kvCommand(["SET", key, payload]);
    }
    return;
  }
  const store = getMemoryStore();
  const expiresAt = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? Date.now() + Math.floor(ttlSeconds * 1000)
    : null;
  store.set(key, { value: payload, expiresAt });
}

async function deleteValue(key) {
  if (KV_ENABLED) {
    await kvCommand(["DEL", key]);
    return;
  }
  getMemoryStore().delete(key);
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value || "").toLowerCase()).digest("hex");
}

function sha256Raw(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
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
    if (typeof input === "string") return String(input).trim();
    if (typeof input === "boolean") return input;
    return String(input);
  };
  return JSON.stringify(walk(value));
}

function emailIndexKey(email) {
  return `ri:user:email:${sha256(email)}`;
}

function userKey(userId) {
  return `ri:user:${String(userId || "").trim()}`;
}

function researchesKey(userId) {
  return `ri:user:${String(userId || "").trim()}:researches`;
}

function userResearchesLockKey(userId) {
  return `${researchesKey(userId)}:lock`;
}

function stageCacheKey(userId, runId, stageId) {
  return `ri:user:${String(userId || "").trim()}:run:${String(runId || "").trim()}:stage:${String(stageId || "").trim()}`;
}

function stageCacheIndexKey(userId, runId) {
  return `ri:user:${String(userId || "").trim()}:run:${String(runId || "").trim()}:stage-index`;
}

function rawCallRunIndexKey(userId, runId) {
  return `ri:user:${String(userId || "").trim()}:run:${String(runId || "").trim()}:rawcall-run-index`;
}

function rawCallStageIndexKey(userId, runId, stageId) {
  return `ri:user:${String(userId || "").trim()}:run:${String(runId || "").trim()}:rawcall-stage-index:${String(stageId || "").trim()}`;
}

function rawCallEntryKey(userId, runId, stageId, chunkId, callIndex) {
  return `ri:user:${String(userId || "").trim()}:run:${String(runId || "").trim()}:rawcall:${String(stageId || "").trim()}:${String(chunkId || "default").trim()}:${Math.max(0, Number(callIndex) || 0)}`;
}

function rawCallChunkLockKey(userId, runId, stageId, chunkId) {
  return `ri:user:${String(userId || "").trim()}:run:${String(runId || "").trim()}:rawcall-lock:${String(stageId || "").trim()}:${String(chunkId || "default").trim()}`;
}

function rawCallStageLockKey(userId, runId, stageId) {
  return `ri:user:${String(userId || "").trim()}:run:${String(runId || "").trim()}:rawcall-stage-lock:${String(stageId || "").trim()}`;
}

function magicTokenKey(token) {
  return `ri:auth:magic:${String(token || "").trim()}`;
}

function userEmailLockKey(email) {
  return `${emailIndexKey(email)}:lock`;
}

function createUserRecord(email) {
  return {
    id: crypto.randomUUID(),
    email: String(email || "").trim().toLowerCase(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

const DEFAULT_RAW_CALL_CACHE_STAGES = new Set([
  "stage_03a_evidence_memory",
  "stage_03b_evidence_web",
  "stage_03c_evidence_deep_assist",
  "stage_08_recover",
]);

function parseRawCallCacheStages(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return new Set(DEFAULT_RAW_CALL_CACHE_STAGES);
  return new Set(
    text
      .split(",")
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  );
}

function rawCallCacheDisabled() {
  const raw = String(process.env.RESEARCHIT_RAW_CALL_CACHE_DISABLED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function getStorageMode() {
  return KV_ENABLED ? "kv" : "memory";
}

export function getStorageDiagnostics() {
  return {
    mode: getStorageMode(),
    kvConfigured: KV_ENABLED,
    nodeEnv: String(process.env.NODE_ENV || "").trim().toLowerCase() || "unknown",
    vercelEnv: String(process.env.VERCEL_ENV || "").trim().toLowerCase() || "unknown",
    productionLike: isProductionEnv(),
  };
}

export function getRawCallCacheStages() {
  if (rawCallCacheDisabled()) return new Set();
  return parseRawCallCacheStages(process.env.RESEARCHIT_RAW_CALL_CACHE_STAGES);
}

export function isRawCallCacheEnabledForStage(stageId = "") {
  const stage = String(stageId || "").trim();
  if (!stage) return false;
  return getRawCallCacheStages().has(stage);
}

export function assertPersistentStoreAvailable() {
  if (KV_ENABLED) return;
  if (isProductionEnv()) {
    const err = new Error("KV_REST_API_URL and KV_REST_API_TOKEN are required in production.");
    err.code = "KV_REQUIRED_IN_PRODUCTION";
    throw err;
  }
}

export async function getUserById(userId) {
  if (!userId) return null;
  return getValue(userKey(userId));
}

export async function getOrCreateUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  return withKvLock(userEmailLockKey(normalized), async () => {
    const existingUserId = await getValue(emailIndexKey(normalized));
    if (existingUserId) {
      const existing = await getUserById(existingUserId);
      if (existing) return existing;
    }

    const created = createUserRecord(normalized);
    await setValue(userKey(created.id), created);
    await setValue(emailIndexKey(normalized), created.id);
    return created;
  });
}

export async function putMagicToken(token, payload, ttlSeconds = 900) {
  if (!token) return;
  await setValue(magicTokenKey(token), {
    ...(payload || {}),
    createdAt: nowIso(),
  }, { ttlSeconds });
}

export async function consumeMagicToken(token) {
  const value = await getValue(magicTokenKey(token));
  if (!value) return null;
  await deleteValue(magicTokenKey(token));
  return value;
}

export async function getUserResearches(userId) {
  if (!userId) return [];
  const stored = await getValue(researchesKey(userId));
  if (!stored || typeof stored !== "object") return [];
  return Object.values(stored)
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => {
      const aTime = Date.parse(a.updatedAt || a.createdAt || "") || 0;
      const bTime = Date.parse(b.updatedAt || b.createdAt || "") || 0;
      return bTime - aTime;
    });
}

export async function upsertUserResearches(userId, researches = []) {
  if (!userId) return { upserted: 0, total: 0 };
  return withKvLock(userResearchesLockKey(userId), async () => {
    const currentList = await getUserResearches(userId);
    const map = Object.fromEntries(currentList.map((item) => [item.id, item]));
    let upserted = 0;

    const items = Array.isArray(researches) ? researches : [researches];
    items.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const id = String(item.id || "").trim();
      if (!id) return;
      const createdAt = String(item.createdAt || map[id]?.createdAt || nowIso());
      const updatedAt = String(item.updatedAt || nowIso());
      map[id] = {
        ...item,
        id,
        ownerId: userId,
        createdAt,
        updatedAt,
        storedAt: nowIso(),
      };
      upserted += 1;
    });

    const capped = Object.values(map)
      .sort((a, b) => {
        const aTime = Date.parse(a.updatedAt || a.createdAt || "") || 0;
        const bTime = Date.parse(b.updatedAt || b.createdAt || "") || 0;
        return bTime - aTime;
      })
      .slice(0, 500);

    const payload = Object.fromEntries(capped.map((item) => [item.id, item]));
    await setValue(researchesKey(userId), payload);
    return { upserted, total: capped.length };
  });
}

export async function deleteUserResearch(userId, researchId) {
  if (!userId || !researchId) return false;
  return withKvLock(userResearchesLockKey(userId), async () => {
    const list = await getUserResearches(userId);
    const map = Object.fromEntries(list.map((item) => [item.id, item]));
    if (!map[researchId]) return false;
    delete map[researchId];
    await setValue(researchesKey(userId), map);
    return true;
  });
}

export async function getStageCache(userId, runId, stageId, hashInputs = {}) {
  const safeUserId = String(userId || "").trim();
  const safeRunId = String(runId || "").trim();
  const safeStageId = String(stageId || "").trim();
  if (!safeUserId || !safeRunId || !safeStageId) {
    return {
      cacheHit: false,
      missReason: "no_entry",
      cacheKey: stageCacheKey(safeUserId, safeRunId, safeStageId),
      hash: "",
      hashInputs,
      cacheAgeMs: 0,
      output: null,
    };
  }

  const cacheKey = stageCacheKey(safeUserId, safeRunId, safeStageId);
  const hash = sha256Raw(stableStringify(hashInputs));
  const stored = await getValue(cacheKey);
  if (!stored || typeof stored !== "object") {
    return {
      cacheHit: false,
      missReason: "no_entry",
      cacheKey,
      hash,
      hashInputs,
      cacheAgeMs: 0,
      output: null,
    };
  }

  const storedHash = String(stored?.hash || "").trim();
  if (!storedHash || storedHash !== hash) {
    const previousInputs = stored?.hashInputs && typeof stored.hashInputs === "object"
      ? stored.hashInputs
      : {};
    let missReason = "hash_mismatch";
    if (String(previousInputs?.promptVersion || "") !== String(hashInputs?.promptVersion || "")) {
      missReason = "bypass_prompt_version_mismatch";
    } else if (String(previousInputs?.upstreamHash || "") !== String(hashInputs?.upstreamHash || "")) {
      missReason = "bypass_upstream_changed";
    }
    return {
      cacheHit: false,
      missReason,
      cacheKey,
      hash,
      hashInputs,
      cacheAgeMs: 0,
      output: null,
    };
  }

  const storedAt = Date.parse(String(stored?.storedAt || ""));
  return {
    cacheHit: true,
    missReason: null,
    cacheKey,
    hash,
    hashInputs,
    cacheAgeMs: Number.isFinite(storedAt) ? Math.max(0, Date.now() - storedAt) : 0,
    output: stored?.output && typeof stored.output === "object" ? stored.output : null,
  };
}

export async function setStageCache(userId, runId, stageId, hashInputs = {}, output = null, ttlSeconds = 7 * 86400) {
  const safeUserId = String(userId || "").trim();
  const safeRunId = String(runId || "").trim();
  const safeStageId = String(stageId || "").trim();
  if (!safeUserId || !safeRunId || !safeStageId) return { ok: false, bytes: 0 };

  const cacheKey = stageCacheKey(safeUserId, safeRunId, safeStageId);
  const hash = sha256Raw(stableStringify(hashInputs));
  const payload = {
    hash,
    output: output && typeof output === "object" ? output : null,
    storedAt: nowIso(),
    hashInputs: hashInputs && typeof hashInputs === "object" ? hashInputs : {},
  };
  const serialized = JSON.stringify(payload);
  await setValue(cacheKey, payload, { ttlSeconds });

  const indexKey = stageCacheIndexKey(safeUserId, safeRunId);
  const existingIndex = await getValue(indexKey);
  const list = Array.isArray(existingIndex) ? existingIndex : [];
  const next = [...new Set([...list, safeStageId])];
  await setValue(indexKey, next, { ttlSeconds });

  return {
    ok: true,
    cacheKey,
    hash,
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

export async function deleteRunStageCache(userId, runId) {
  const safeUserId = String(userId || "").trim();
  const safeRunId = String(runId || "").trim();
  if (!safeUserId || !safeRunId) return { deleted: 0 };

  const indexKey = stageCacheIndexKey(safeUserId, safeRunId);
  const existingIndex = await getValue(indexKey);
  const stages = Array.isArray(existingIndex) ? existingIndex : [];
  let deleted = 0;
  for (const stageId of stages) {
    const key = stageCacheKey(safeUserId, safeRunId, stageId);
    await deleteValue(key);
    deleted += 1;
  }
  await deleteValue(indexKey);
  return { deleted };
}

const REDACTED_KEYS = new Set([
  "authorization",
  "api-key",
  "apikey",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);

function sanitizeRawResponse(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((item) => sanitizeRawResponse(item, depth + 1));
  if (!value || typeof value !== "object") return value ?? null;
  const out = {};
  Object.keys(value).forEach((key) => {
    const normalized = String(key || "").trim().toLowerCase();
    if (REDACTED_KEYS.has(normalized)) return;
    out[key] = sanitizeRawResponse(value[key], depth + 1);
  });
  return out;
}

export async function appendRawProviderCall(userId, runId, stageId, payload = {}, options = {}) {
  const safeUserId = String(userId || "").trim();
  const safeRunId = String(runId || "").trim();
  const safeStageId = String(stageId || "").trim();
  const safeChunkId = String(payload?.chunkId || "default").trim() || "default";
  if (!safeUserId || !safeRunId || !safeStageId) {
    return { ok: false, skipped: true, reason: "missing_identity" };
  }
  const ttlSeconds = Number.isFinite(Number(options?.ttlSeconds))
    ? Math.max(60, Math.floor(Number(options.ttlSeconds)))
    : 7 * 86400;
  return withKvLock(
    rawCallChunkLockKey(safeUserId, safeRunId, safeStageId, safeChunkId),
    async () => {
      const stageIndexKey = rawCallStageIndexKey(safeUserId, safeRunId, safeStageId);
      const stageIndex = await getValue(stageIndexKey);
      const entries = Array.isArray(stageIndex) ? stageIndex.filter((item) => item && typeof item === "object") : [];
      const existingChunkEntries = entries.filter((entry) => String(entry?.chunkId || "default") === safeChunkId);
      const nextCallIndex = existingChunkEntries.reduce((max, entry) => {
        const n = Number(entry?.callIndex || 0);
        return Number.isFinite(n) && n > max ? n : max;
      }, -1) + 1;

      const entryKey = rawCallEntryKey(safeUserId, safeRunId, safeStageId, safeChunkId, nextCallIndex);
      const normalizedPayload = {
        provider: String(payload?.provider || "").trim().toLowerCase(),
        model: String(payload?.model || "").trim(),
        stageId: safeStageId,
        chunkId: safeChunkId,
        callIndex: nextCallIndex,
        requestHash: String(payload?.requestHash || "").trim(),
        promptVersion: String(payload?.promptVersion || "").trim(),
        rawResponse: sanitizeRawResponse(payload?.rawResponse),
        storedAt: nowIso(),
      };
      await setValue(entryKey, normalizedPayload, { ttlSeconds });

      await withKvLock(
        rawCallStageLockKey(safeUserId, safeRunId, safeStageId),
        async () => {
          const stageIndexLatest = await getValue(stageIndexKey);
          const stageEntries = Array.isArray(stageIndexLatest)
            ? stageIndexLatest.filter((item) => item && typeof item === "object")
            : [];
          const stageEntry = {
            key: entryKey,
            chunkId: safeChunkId,
            callIndex: nextCallIndex,
            provider: normalizedPayload.provider,
            model: normalizedPayload.model,
            requestHash: normalizedPayload.requestHash,
            promptVersion: normalizedPayload.promptVersion,
            storedAt: normalizedPayload.storedAt,
          };
          const nextStageEntries = [
            ...stageEntries.filter((entry) => String(entry?.key || "").trim() !== entryKey),
            stageEntry,
          ];
          await setValue(stageIndexKey, nextStageEntries, { ttlSeconds });

          const runIndexKey = rawCallRunIndexKey(safeUserId, safeRunId);
          const runIndex = await getValue(runIndexKey);
          const runStages = Array.isArray(runIndex) ? runIndex.map((item) => String(item || "").trim()).filter(Boolean) : [];
          const nextRunStages = [...new Set([...runStages, safeStageId])];
          await setValue(runIndexKey, nextRunStages, { ttlSeconds });
        }
      );

      return {
        ok: true,
        rawResponseKey: entryKey,
        stageId: safeStageId,
        chunkId: safeChunkId,
        callIndex: nextCallIndex,
      };
    }
  );
}

export async function listRawProviderCalls(userId, runId, stageId) {
  const safeUserId = String(userId || "").trim();
  const safeRunId = String(runId || "").trim();
  const safeStageId = String(stageId || "").trim();
  if (!safeUserId || !safeRunId || !safeStageId) return [];
  const stageIndexKey = rawCallStageIndexKey(safeUserId, safeRunId, safeStageId);
  const stageIndex = await getValue(stageIndexKey);
  const entries = Array.isArray(stageIndex) ? stageIndex.filter((item) => item && typeof item === "object") : [];
  const out = [];
  for (const entry of entries) {
    const key = String(entry?.key || "").trim();
    if (!key) continue;
    const payload = await getValue(key);
    if (!payload || typeof payload !== "object") continue;
    out.push({
      key,
      chunkId: String(payload?.chunkId || entry?.chunkId || "default").trim() || "default",
      callIndex: Number(payload?.callIndex ?? entry?.callIndex ?? 0) || 0,
      provider: String(payload?.provider || entry?.provider || "").trim().toLowerCase(),
      model: String(payload?.model || entry?.model || "").trim(),
      requestHash: String(payload?.requestHash || entry?.requestHash || "").trim(),
      promptVersion: String(payload?.promptVersion || entry?.promptVersion || "").trim(),
      storedAt: String(payload?.storedAt || entry?.storedAt || "").trim(),
      rawResponse: sanitizeRawResponse(payload?.rawResponse),
    });
  }
  out.sort((a, b) => {
    const chunkCmp = String(a.chunkId).localeCompare(String(b.chunkId));
    if (chunkCmp !== 0) return chunkCmp;
    return Number(a.callIndex || 0) - Number(b.callIndex || 0);
  });
  return out;
}

export async function deleteRunRawProviderCalls(userId, runId) {
  const safeUserId = String(userId || "").trim();
  const safeRunId = String(runId || "").trim();
  if (!safeUserId || !safeRunId) return { deleted: 0 };

  const runIndexKey = rawCallRunIndexKey(safeUserId, safeRunId);
  const runIndex = await getValue(runIndexKey);
  const stages = Array.isArray(runIndex) ? runIndex.map((item) => String(item || "").trim()).filter(Boolean) : [];
  let deleted = 0;
  for (const stageId of stages) {
    const stageIndexKey = rawCallStageIndexKey(safeUserId, safeRunId, stageId);
    const stageIndex = await getValue(stageIndexKey);
    const entries = Array.isArray(stageIndex) ? stageIndex.filter((item) => item && typeof item === "object") : [];
    for (const entry of entries) {
      const key = String(entry?.key || "").trim();
      if (!key) continue;
      await deleteValue(key);
      deleted += 1;
    }
    await deleteValue(stageIndexKey);
  }
  await deleteValue(runIndexKey);
  return { deleted };
}
