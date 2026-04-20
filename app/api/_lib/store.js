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
  if (!KV_ENABLED) {
    return fn();
  }
  const ttlSeconds = Math.max(2, Number(options?.ttlSeconds) || KV_LOCK_TTL_SECONDS);
  const maxWaitMs = Math.max(300, Number(options?.maxWaitMs) || KV_LOCK_WAIT_MS);
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

export function getStorageMode() {
  return KV_ENABLED ? "kv" : "memory";
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
