import { safeParseJSON } from "../lib/json.js";
import { estimateTokens } from "../lib/guards/token-preflight.js";
import { runCanonicalPipeline } from "./orchestrator.js";

function clean(value) {
  return String(value || "").trim();
}

function slugify(value, fallback = "subject") {
  const out = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || fallback;
}

function uniqBy(items = [], keyFn = (item) => item) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

function normalizeSubjects(items = []) {
  return uniqBy(
    (Array.isArray(items) ? items : [])
      .map((item, idx) => {
        if (typeof item === "string") {
          const label = clean(item);
          if (!label) return null;
          return { id: slugify(label, `subject-${idx + 1}`), label, aliases: [] };
        }
        const label = clean(item?.label || item?.name || item?.id);
        if (!label) return null;
        const aliases = Array.isArray(item?.aliases)
          ? [...new Set(item.aliases.map((alias) => clean(alias)).filter(Boolean))]
          : [];
        return {
          id: clean(item?.id) || slugify(label, `subject-${idx + 1}`),
          label,
          aliases,
        };
      })
      .filter(Boolean),
    (subject) => clean(subject.label).toLowerCase()
  );
}

function extractSubjectsFromText(description = "") {
  const text = clean(description);
  if (!text) return [];
  const candidates = text
    .split(/\n|,|;|\.|\|/)
    .map((item) => clean(item))
    .filter((item) => item.length >= 2 && item.length <= 80);

  const likely = candidates.filter((item) => /[A-Za-z]/.test(item));
  return normalizeSubjects(likely.slice(0, 12));
}

async function discoverSubjectsWithAnalyst({ input, config, transport }) {
  if (!transport?.callAnalyst) return [];
  const prompt = `Suggest 4 to 8 concrete comparison subjects for this matrix objective.
Objective: ${clean(input?.description)}
Return JSON:
{
  "subjects": [{"label":"", "aliases":[""]}],
  "notes": ""
}`;

  const response = await transport.callAnalyst(
    [{ role: "user", content: prompt }],
    config?.prompts?.analyst || "You propose matrix subjects.",
    4000,
    {
      liveSearch: true,
      includeMeta: true,
      provider: config?.models?.retrieval?.provider || "gemini",
      model: config?.models?.retrieval?.model || "gemini-2.5-pro",
      webSearchModel: config?.models?.retrieval?.webSearchModel || config?.models?.retrieval?.model || "gemini-2.5-pro",
      retry: { maxRetries: 1 },
      timeoutMs: 60000,
    }
  );

  const parsed = safeParseJSON(response?.text || response);
  return normalizeSubjects(parsed?.subjects || []);
}

export async function resolveMatrixResearchInput(input, config, callbacks = {}, options = {}) {
  const matrixSubjects = normalizeSubjects(input?.options?.matrixSubjects || []);
  const extractedSubjects = extractSubjectsFromText(input?.description || "");

  let subjects = matrixSubjects.length ? matrixSubjects : extractedSubjects;
  let usedSubjectDiscovery = false;

  if (!subjects.length) {
    const discovered = await discoverSubjectsWithAnalyst({ input, config, transport: callbacks?.transport });
    subjects = discovered;
    usedSubjectDiscovery = discovered.length > 0;
  }

  const minCount = Math.max(2, Number(config?.subjectsSpec?.minCount) || 2);
  if (subjects.length < minCount) {
    throw new Error(`Matrix setup requires at least ${minCount} subjects.`);
  }

  return {
    subjects,
    extractedSubjects,
    usedSubjectDiscovery,
    requiresConfirmation: options?.requireConfirmation !== false,
    discoveryMeta: {
      suggestedCount: subjects.length,
    },
    requiredSubjects: [],
    missingRequiredSubjects: [],
    subjectCanonicalization: { mergedAliases: [] },
  };
}

export async function runMatrixAnalysis(input, config, callbacks = {}) {
  const transport = callbacks?.transport;
  if (!transport?.callAnalyst || !transport?.callCritic) {
    throw new Error("runMatrixAnalysis requires callbacks.transport with analyst/critic.");
  }

  let resolvedInput = input;
  if (!Array.isArray(input?.options?.matrixSubjects) || !input.options.matrixSubjects.length) {
    const resolved = await resolveMatrixResearchInput(input, config, callbacks, { requireConfirmation: false });
    resolvedInput = {
      ...(input || {}),
      options: {
        ...(input?.options || {}),
        matrixSubjects: resolved.subjects.map((subject) => subject.label),
      },
    };
  }

  return runCanonicalPipeline(resolvedInput, {
    ...(config || {}),
    outputMode: "matrix",
  }, callbacks);
}

function trimCell(cell = {}, max = 240) {
  const value = clean(cell?.value);
  const full = clean(cell?.full || cell?.confidenceReason || "");
  const sourceText = (Array.isArray(cell?.sources) ? cell.sources : [])
    .slice(0, 3)
    .map((source) => `${clean(source?.name)} ${clean(source?.url)}`.trim())
    .filter(Boolean)
    .join(" | ");
  return `${clean(cell?.subjectId)}::${clean(cell?.attributeId)} | ${value} | ${full} | ${sourceText}`.slice(0, max);
}

function buildCellBlock(cells = [], maxPerCell = 240) {
  return (Array.isArray(cells) ? cells : [])
    .map((cell) => `- ${trimCell(cell, maxPerCell)}`)
    .join("\n");
}

function compactPrompt(build, cells = [], targetTokenBudget = 12000) {
  const target = Math.max(1200, Number(targetTokenBudget) || 12000);
  const totalCells = Array.isArray(cells) ? cells.length : 0;
  let included = totalCells;
  let maxPerCell = 260;
  let promptText = build(cells, maxPerCell);
  let estimatedTokens = estimateTokens(promptText);

  while (estimatedTokens > target && included > 1) {
    included = Math.max(1, Math.ceil(included / 2));
    if (maxPerCell > 120) maxPerCell = Math.max(120, Math.floor(maxPerCell * 0.8));
    promptText = build(cells.slice(0, included), maxPerCell);
    estimatedTokens = estimateTokens(promptText);
  }

  if (estimatedTokens > target) {
    const maxChars = Math.max(1200, Math.floor(target * 3.5));
    promptText = `${promptText.slice(0, maxChars)}\n[...compacted]`;
    estimatedTokens = estimateTokens(promptText);
    if (estimatedTokens > target) {
      promptText = promptText.slice(0, Math.max(800, Math.floor(target * 2.6)));
      estimatedTokens = estimateTokens(promptText);
    }
  }

  return {
    promptText,
    compactionMeta: {
      targetTokenBudget: target,
      estimatedTokens,
      totalCells,
      cellsIncluded: included,
      maxPerCell,
      compacted: included < totalCells || maxPerCell < 260,
    },
  };
}

function buildMatrixCriticPrompt({ rawInput = "", decisionQuestion = "", subjects = [], attributes = [], matrix = {}, limits = {} } = {}) {
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const targetTokenBudget = Number(limits?.matrixCriticPromptTokenBudget) || 12000;

  const build = (subset = [], maxPerCell = 240) => {
    const subjectLines = (Array.isArray(subjects) ? subjects : [])
      .slice(0, 40)
      .map((subject) => `- ${clean(subject?.id)}: ${clean(subject?.label)}`)
      .join("\n");
    const attributeLines = (Array.isArray(attributes) ? attributes : [])
      .slice(0, 40)
      .map((attribute) => `- ${clean(attribute?.id)}: ${clean(attribute?.label)}`)
      .join("\n");

    return `Critic audit for matrix consistency and overclaims.
Objective: ${clean(rawInput)}
Decision question: ${clean(decisionQuestion)}
Subjects:
${subjectLines}
Attributes:
${attributeLines}
Cells:
${buildCellBlock(subset, maxPerCell)}
Return strict JSON with flags only.`;
  };

  return compactPrompt(build, cells, targetTokenBudget);
}

function buildMatrixConsistencyPrompt({ decisionQuestion = "", subjects = [], attributes = [], matrix = {}, limits = {} } = {}) {
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const targetTokenBudget = Number(limits?.matrixConsistencyPromptTokenBudget) || 9000;

  const build = (subset = [], maxPerCell = 220) => {
    const subjectsShort = (Array.isArray(subjects) ? subjects : []).map((subject) => clean(subject?.label || subject?.id)).slice(0, 30).join(", ");
    const attributesShort = (Array.isArray(attributes) ? attributes : []).map((attribute) => clean(attribute?.label || attribute?.id)).slice(0, 30).join(", ");

    return `Matrix consistency check.
Decision question: ${clean(decisionQuestion)}
Subjects: ${subjectsShort}
Attributes: ${attributesShort}
Cells:
${buildCellBlock(subset, maxPerCell)}
Return JSON consistency findings only.`;
  };

  return compactPrompt(build, cells, targetTokenBudget);
}

export const __test__ = {
  buildMatrixCriticPrompt,
  buildMatrixConsistencyPrompt,
};
