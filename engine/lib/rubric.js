function limitWords(text, maxWords = 18) {
  if (!text) return "";
  const parts = String(text).trim().split(/\s+/);
  if (parts.length <= maxWords) return parts.join(" ");
  return `${parts.slice(0, maxWords).join(" ")}...`;
}

function extractScoreLine(fullDef, score) {
  if (!fullDef) return "";
  const re = new RegExp(`Score\\s+${score}[^:]*:\\s*([^\\n]+)`, "i");
  const m = String(fullDef).match(re);
  return m?.[1]?.trim() || "";
}
export function getPolarityHint(dim) {
  const configured = String(dim?.polarityHint || "").trim();
  if (configured) return configured;
  return "Higher score = stronger evidence-backed attractiveness for this decision.";
}

export function buildDimRubricReminder(dim, options = {}) {
  if (!dim) return "";
  const wordCap = options.wordCap || 14;
  const s5 = limitWords(extractScoreLine(dim.fullDef, 5), wordCap);
  const s3 = limitWords(extractScoreLine(dim.fullDef, 3), wordCap);
  const s1 = limitWords(extractScoreLine(dim.fullDef, 1), wordCap);
  return [
    `${dim.label} [${dim.id}]`,
    `- ${getPolarityHint(dim)}`,
    `- Score 5 anchor: ${s5 || "n/a"}`,
    `- Score 3 anchor: ${s3 || "n/a"}`,
    `- Score 1 anchor: ${s1 || "n/a"}`,
  ].join("\n");
}

export function buildRubricCalibrationBlock(dims = [], options = {}) {
  const wordCap = options.wordCap || 12;
  return (dims || [])
    .map((d) => {
      const s5 = limitWords(extractScoreLine(d.fullDef, 5), wordCap);
      const s1 = limitWords(extractScoreLine(d.fullDef, 1), wordCap);
      return `- ${d.label} [${d.id}]: ${getPolarityHint(d)} | Score5: ${s5 || "n/a"} | Score1: ${s1 || "n/a"}`;
    })
    .join("\n");
}
