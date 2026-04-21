import { requireSessionUser } from "../../../_lib/auth.js";
import {
  assertPersistentStoreAvailable,
  listRawProviderCalls,
} from "../../../_lib/store.js";

function clean(value) {
  return String(value || "").trim();
}

export default async function handler(req, res) {
  const auth = await requireSessionUser(req, res);
  if (!auth.user) return auth.handled;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    assertPersistentStoreAvailable();
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Persistent storage is not configured" });
  }

  const runId = clean(req.query?.runId);
  const stageId = clean(req.query?.stageId);
  if (!runId || !stageId) {
    return res.status(400).json({ error: "Missing runId or stageId" });
  }

  try {
    const calls = await listRawProviderCalls(auth.user.id, runId, stageId);
    return res.status(200).json({
      ok: true,
      runId,
      stageId,
      calls,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed to load raw calls" });
  }
}
