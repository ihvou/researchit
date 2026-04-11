import crypto from "node:crypto";

const KV_URL = String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const KV_TOKEN = String(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const KV_ENABLED = !!(KV_URL && KV_TOKEN);

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

function emailIndexKey(email) {
  return `ri:user:email:${sha256(email)}`;
}

function userKey(userId) {
  return `ri:user:${String(userId || "").trim()}`;
}

function researchesKey(userId) {
  return `ri:user:${String(userId || "").trim()}:researches`;
}

function magicTokenKey(token) {
  return `ri:auth:magic:${String(token || "").trim()}`;
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

export async function getUserById(userId) {
  if (!userId) return null;
  return getValue(userKey(userId));
}

export async function getOrCreateUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  const existingUserId = await getValue(emailIndexKey(normalized));
  if (existingUserId) {
    const existing = await getUserById(existingUserId);
    if (existing) return existing;
  }

  const created = createUserRecord(normalized);
  await setValue(userKey(created.id), created);
  await setValue(emailIndexKey(normalized), created.id);
  return created;
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
}

export async function deleteUserResearch(userId, researchId) {
  if (!userId || !researchId) return false;
  const list = await getUserResearches(userId);
  const map = Object.fromEntries(list.map((item) => [item.id, item]));
  if (!map[researchId]) return false;
  delete map[researchId];
  await setValue(researchesKey(userId), map);
  return true;
}
