import crypto from "node:crypto";
import { requireSessionUser } from "../_lib/auth.js";
import {
  assertPersistentStoreAvailable,
  deleteRunStageCache,
  deleteUserResearch,
  getUserResearches,
  upsertUserResearches,
} from "../_lib/store.js";

function normalizeResearch(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "").trim() || crypto.randomUUID();
  const createdAt = String(input.createdAt || new Date().toISOString());
  const updatedAt = String(input.updatedAt || new Date().toISOString());
  const normalized = {
    ...input,
    id,
    createdAt,
    updatedAt,
  };
  const serialized = JSON.stringify(normalized);
  if (serialized.length > 950_000) {
    throw new Error("Research payload is too large to store.");
  }
  return normalized;
}

export default async function handler(req, res) {
  const auth = await requireSessionUser(req, res);
  if (!auth.user) return auth.handled;
  try {
    assertPersistentStoreAvailable();
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Persistent storage is not configured" });
  }

  if (req.method === "GET") {
    try {
      const researches = await getUserResearches(auth.user.id);
      return res.status(200).json({
        ok: true,
        researches,
      });
    } catch (err) {
      return res.status(500).json({ error: err?.message || "Failed to load researches" });
    }
  }

  if (req.method === "POST" || req.method === "PUT") {
    try {
      const body = req.body || {};
      const candidates = Array.isArray(body?.researches)
        ? body.researches
        : (body?.research ? [body.research] : []);

      const normalized = candidates
        .map((item) => normalizeResearch(item))
        .filter(Boolean);

      if (!normalized.length) {
        return res.status(400).json({ error: "No research payload provided" });
      }

      const result = await upsertUserResearches(auth.user.id, normalized);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(400).json({ error: err?.message || "Failed to save research" });
    }
  }

  if (req.method === "DELETE") {
    const id = String(req.body?.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "Missing research id" });
    }
    try {
      const deleted = await deleteUserResearch(auth.user.id, id);
      if (deleted) {
        await deleteRunStageCache(auth.user.id, id).catch(() => null);
      }
      return res.status(200).json({ ok: true, deleted });
    } catch (err) {
      return res.status(500).json({ error: err?.message || "Failed to delete research" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
