export function normalizeConfidenceLevel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("h")) return "high";
  if (raw.startsWith("m")) return "medium";
  if (raw.startsWith("l")) return "low";
  return null;
}

export function confidenceLabel(level) {
  if (level === "high") return "High confidence";
  if (level === "medium") return "Medium confidence";
  if (level === "low") return "Low confidence";
  return "Confidence unavailable";
}

export function confidenceTone(level) {
  if (level === "high") {
    return {
      bg: "#e9f8ee",
      line: "#b3e3c4",
      ink: "#12805c",
      short: "High",
      icon: "🟢",
    };
  }
  if (level === "medium") {
    return {
      bg: "#fff6e8",
      line: "#f5d7a3",
      ink: "#9a6507",
      short: "Med",
      icon: "🟡",
    };
  }
  if (level === "low") {
    return {
      bg: "#fff1ef",
      line: "#f3c2ba",
      ink: "#b42318",
      short: "Low",
      icon: "🔴",
    };
  }
  return {
    bg: "#f3f4f6",
    line: "#d1d5db",
    ink: "#6b7280",
    short: "N/A",
    icon: "⚪",
  };
}

export function confidenceTitle(level, reason) {
  const base = confidenceLabel(level);
  if (!reason) return base;
  return `${base}: ${reason}`;
}
