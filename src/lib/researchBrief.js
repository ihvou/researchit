import { normalizeConfidenceLevel } from "./confidence";

function cleanText(value) {
  return String(value || "").trim();
}

function trimSentence(text, fallback = "") {
  const raw = cleanText(text);
  if (!raw) return fallback;
  if (raw.length <= 220) return raw;
  return `${raw.slice(0, 217)}...`;
}

function compactPhrase(text, maxWords = 9) {
  const raw = cleanText(text);
  if (!raw) return "";
  const words = raw.split(/\s+/).slice(0, maxWords);
  return words.join(" ");
}

function normalizeList(input, maxItems = 4) {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => cleanText(v))
    .filter(Boolean)
    .slice(0, maxItems);
}

function inferMissingEvidence({ explicitGap, confidenceReason, risks, sourceCount, dimLabel, vertical }) {
  const gap = cleanText(explicitGap);
  if (gap) return trimSentence(gap);

  const reason = cleanText(confidenceReason);
  if (reason) return trimSentence(reason);

  const risk = cleanText(risks);
  if (risk) return trimSentence(risk);

  const market = cleanText(vertical) || "this market";
  const sourceHint = sourceCount > 0
    ? `Only ${sourceCount} public source${sourceCount === 1 ? "" : "s"} were identified.`
    : "No verifiable public sources were identified yet.";
  return `Evidence is still thin for ${cleanText(dimLabel) || "this dimension"} in ${market}. ${sourceHint}`;
}

function whereToLookByDimension(dimId, vertical, aiType) {
  const v = cleanText(vertical) || "target vertical";
  const ai = cleanText(aiType) || "the solution type";
  const generic = [
    `Independent analyst reports and benchmark studies focused on ${v}.`,
    `Named deployment case studies from operators in ${v}, not only vendor blogs.`,
    "Internal delivery post-mortems, client references, or implementation retrospectives.",
  ];

  const map = {
    roi: [
      "Public filings / annual reports with quantified cost or revenue impact.",
      "Independent benchmark reports comparing baseline vs post-deployment economics.",
      ...generic.slice(2),
    ],
    evidence: [
      "Peer-reviewed or audited deployments with measurable production outcomes.",
      "Industry publications citing named implementations, metrics, and timeline.",
      ...generic.slice(2),
    ],
    build_vs_buy: [
      `Current product pages, pricing docs, and release notes for incumbent ${ai} vendors.`,
      `Third-party competitive analyses for ${v} solutions and implementation scope.`,
      ...generic.slice(2),
    ],
    change_mgmt: [
      "Transformation case studies describing adoption blockers and rollout metrics.",
      "Operations playbooks from teams that moved from pilot to scaled production.",
      ...generic.slice(2),
    ],
  };

  return normalizeList(map[dimId] || generic, 3);
}

function suggestedQueries({ title, vertical, dimLabel, missingEvidence, aiType }) {
  const baseTitle = compactPhrase(title, 7);
  const baseVertical = compactPhrase(vertical, 4);
  const baseDim = compactPhrase(dimLabel, 4);
  const gap = compactPhrase(missingEvidence, 8);
  const ai = compactPhrase(aiType, 4);

  return normalizeList([
    `${baseTitle || "use case"} ${baseVertical || "enterprise"} ${baseDim || "dimension"} deployment metrics`,
    `${baseVertical || "industry"} ${ai || "AI"} case study audited outcomes ${baseDim || ""}`.trim(),
    `${baseTitle || "use case"} benchmark baseline vs after implementation ${baseDim || ""}`.trim(),
    `${gap || "evidence gap"} ${baseVertical || "industry"} source`,
  ], 4);
}

function normalizeResearchBrief(input) {
  if (!input || typeof input !== "object") return null;
  const missingEvidence = cleanText(input.missingEvidence);
  const whereToLook = normalizeList(input.whereToLook, 4);
  const suggestedQueries = normalizeList(input.suggestedQueries, 4);
  if (!missingEvidence && !whereToLook.length && !suggestedQueries.length) return null;
  return {
    missingEvidence: missingEvidence || "Evidence gap not specified.",
    whereToLook: whereToLook.length ? whereToLook : ["Specific source targets were not provided."],
    suggestedQueries: suggestedQueries.length ? suggestedQueries : ["No targeted queries suggested."],
  };
}

export function getResearchBriefForLowConfidence({
  confidence,
  existingBrief,
  dimId = "",
  dimLabel = "",
  attributes = {},
  missingEvidence = "",
  confidenceReason = "",
  risks = "",
  sources = [],
} = {}) {
  if (normalizeConfidenceLevel(confidence) !== "low") return null;

  const normalizedExisting = normalizeResearchBrief(existingBrief);
  if (normalizedExisting) return normalizedExisting;

  const inferredGap = inferMissingEvidence({
    explicitGap: missingEvidence,
    confidenceReason,
    risks,
    sourceCount: Array.isArray(sources) ? sources.length : 0,
    dimLabel,
    vertical: attributes?.vertical,
  });

  return {
    missingEvidence: inferredGap,
    whereToLook: whereToLookByDimension(dimId, attributes?.vertical, attributes?.aiSolutionType),
    suggestedQueries: suggestedQueries({
      title: attributes?.title || "",
      vertical: attributes?.vertical || "",
      dimLabel,
      missingEvidence: inferredGap,
      aiType: attributes?.aiSolutionType || "",
    }),
  };
}

