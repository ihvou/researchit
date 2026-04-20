import { requireSessionUser } from "../_lib/auth.js";
import {
  assertPersistentStoreAvailable,
  deleteRunStageCache,
  getStageCache,
  setStageCache,
} from "../_lib/store.js";

function clean(value) {
  return String(value || "").trim();
}

export default async function handler(req, res) {
  const auth = await requireSessionUser(req, res);
  if (!auth.user) return auth.handled;
  try {
    assertPersistentStoreAvailable();
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Persistent storage is not configured" });
  }

  if (req.method === "POST") {
    const action = clean(req.body?.action).toLowerCase();
    const runId = clean(req.body?.runId);
    const stageId = clean(req.body?.stageId);
    const hashInputs = req.body?.hashInputs && typeof req.body.hashInputs === "object"
      ? req.body.hashInputs
      : {};

    if (action === "get") {
      if (!runId || !stageId) {
        return res.status(400).json({ error: "Missing runId or stageId" });
      }
      try {
        const payload = await getStageCache(auth.user.id, runId, stageId, hashInputs);
        return res.status(200).json({ ok: true, ...payload });
      } catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to load stage cache" });
      }
    }

    if (action === "set") {
      if (!runId || !stageId) {
        return res.status(400).json({ error: "Missing runId or stageId" });
      }
      try {
        const ttlSeconds = Number(req.body?.ttlSeconds);
        const payload = await setStageCache(
          auth.user.id,
          runId,
          stageId,
          hashInputs,
          req.body?.output && typeof req.body.output === "object" ? req.body.output : null,
          Number.isFinite(ttlSeconds) ? ttlSeconds : undefined
        );
        return res.status(200).json({ ok: true, ...payload });
      } catch (err) {
        return res.status(500).json({ error: err?.message || "Failed to store stage cache" });
      }
    }

    return res.status(400).json({ error: "Unsupported action" });
  }

  if (req.method === "DELETE") {
    const runId = clean(req.body?.runId);
    if (!runId) {
      return res.status(400).json({ error: "Missing runId" });
    }
    try {
      const payload = await deleteRunStageCache(auth.user.id, runId);
      return res.status(200).json({ ok: true, ...payload });
    } catch (err) {
      return res.status(500).json({ error: err?.message || "Failed to clear stage cache" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

