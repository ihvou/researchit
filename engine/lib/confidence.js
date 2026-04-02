export function normalizeConfidenceLevel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("h")) return "high";
  if (raw.startsWith("m")) return "medium";
  if (raw.startsWith("l")) return "low";
  return null;
}
