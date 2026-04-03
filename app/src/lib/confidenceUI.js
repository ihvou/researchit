export function confidenceLabel(level) {
  if (level === "high") return "High confidence";
  if (level === "medium") return "Medium confidence";
  if (level === "low") return "Low confidence";
  return "Confidence unavailable";
}

export function confidenceTone(level) {
  if (level === "high") {
    return {
      bg: "var(--ck-surface-soft)",
      line: "var(--ck-line)",
      ink: "var(--ck-text)",
      short: "High",
      icon: "H",
    };
  }
  if (level === "medium") {
    return {
      bg: "var(--ck-surface-soft)",
      line: "var(--ck-line)",
      ink: "var(--ck-muted)",
      short: "Med",
      icon: "M",
    };
  }
  if (level === "low") {
    return {
      bg: "var(--ck-surface-soft)",
      line: "var(--ck-line-strong)",
      ink: "var(--ck-muted)",
      short: "Low",
      icon: "L",
    };
  }
  return {
    bg: "var(--ck-surface-soft)",
    line: "var(--ck-line)",
    ink: "var(--ck-muted-soft)",
    short: "N/A",
    icon: "-",
  };
}

export function confidenceTitle(level, reason) {
  const base = confidenceLabel(level);
  if (!reason) return base;
  return `${base}: ${reason}`;
}
