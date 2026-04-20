function clean(value) {
  return String(value || "").trim();
}

function stableSortObject(value = {}) {
  const keys = Object.keys(value).sort();
  const out = {};
  keys.forEach((key) => {
    out[key] = value[key];
  });
  return out;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const sorted = stableSortObject(value);
    const out = {};
    Object.keys(sorted).forEach((key) => {
      out[key] = canonicalize(sorted[key]);
    });
    return out;
  }
  if (value == null) return null;
  if (typeof value === "string") return clean(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return String(value);
}

export function canonicalJson(value = {}) {
  return JSON.stringify(canonicalize(value));
}

// Deterministic non-cryptographic hash suitable for cache keys across browser/server.
export function hashCanonicalValue(value = {}) {
  const text = canonicalJson(value);
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

