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

const POLARITY_HINTS = {
  roi: "Higher score = larger, more verifiable financial impact.",
  ai_fit: "Higher score = AI is more essential, not just a marginal enhancer.",
  evidence: "Higher score = stronger and more verifiable real-world evidence.",
  ttv: "Higher score = faster time to measurable value.",
  data_readiness: "Higher score = cleaner, more available client data.",
  feasibility: "Higher score = easier delivery with lower technical complexity.",
  market_size: "Higher score = larger repeatable buyer pool.",
  build_vs_buy: "Higher score = stronger custom-delivery need (weaker SaaS substitution).",
  regulatory: "Higher score = lower regulatory/compliance delivery burden = cleaner delivery profile.",
  change_mgmt: "Higher score = lower disruption and easier organizational adoption.",
  reusability: "Higher score = higher reuse/productization potential.",
};

export function getPolarityHint(dimId) {
  return POLARITY_HINTS[dimId] || "Higher score = stronger outsourcing delivery attractiveness.";
}

export function buildDimRubricReminder(dim, options = {}) {
  if (!dim) return "";
  const wordCap = options.wordCap || 14;
  const s5 = limitWords(extractScoreLine(dim.fullDef, 5), wordCap);
  const s3 = limitWords(extractScoreLine(dim.fullDef, 3), wordCap);
  const s1 = limitWords(extractScoreLine(dim.fullDef, 1), wordCap);
  return [
    `${dim.label} [${dim.id}]`,
    `- ${getPolarityHint(dim.id)}`,
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
      return `- ${d.label} [${d.id}]: ${getPolarityHint(d.id)} | Score5: ${s5 || "n/a"} | Score1: ${s1 || "n/a"}`;
    })
    .join("\n");
}
