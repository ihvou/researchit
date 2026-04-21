import { REASON_CODES } from "../../pipeline/contracts/reason-codes.js";

export function estimateTokens(value) {
  const text = String(value || "");
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function compactLines(text, maxLines = 120) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}\n[...compacted ${lines.length - maxLines} lines]`;
}

export function compactPromptText(promptText, budget = 8000) {
  const limit = Math.max(400, Number(budget) || 8000);
  const normalized = compactLines(compactWhitespace(promptText), 220);
  let text = normalized;
  let tokens = estimateTokens(text);
  if (tokens <= limit) {
    return {
      text,
      tokens,
      compactionApplied: false,
      reasonCodes: [],
    };
  }

  const targetChars = Math.max(1600, Math.floor(limit * 3.4));
  text = `${text.slice(0, targetChars)}\n[...prompt compacted to fit token budget]`;
  tokens = estimateTokens(text);

  return {
    text,
    tokens,
    compactionApplied: true,
    reasonCodes: [REASON_CODES.PROMPT_TOKEN_OVER_BUDGET, REASON_CODES.PROMPT_COMPACTION_APPLIED],
  };
}

export function preparePromptWithinBudget({
  promptText,
  tokenBudget,
  splitStrategy,
  allowCompaction = true,
} = {}) {
  const budget = Math.max(400, Number(tokenBudget) || 8000);
  const applyCompaction = allowCompaction !== false;

  if (!applyCompaction) {
    const estimated = estimateTokens(promptText);
    if (estimated <= budget) {
      return {
        ok: true,
        text: String(promptText || ""),
        estimatedTokens: estimated,
        reasonCodes: [],
        splitApplied: false,
      };
    }
    return {
      ok: false,
      text: String(promptText || ""),
      estimatedTokens: estimated,
      reasonCodes: [REASON_CODES.PROMPT_TOKEN_OVER_BUDGET, REASON_CODES.PROMPT_COMPACTION_EXHAUSTED],
      splitApplied: false,
    };
  }

  const firstPass = compactPromptText(promptText, budget);
  if (firstPass.tokens <= budget) {
    return {
      ok: true,
      text: firstPass.text,
      estimatedTokens: firstPass.tokens,
      reasonCodes: firstPass.reasonCodes,
      splitApplied: false,
    };
  }

  if (typeof splitStrategy !== "function") {
    return {
      ok: false,
      text: firstPass.text,
      estimatedTokens: firstPass.tokens,
      reasonCodes: [...new Set([...firstPass.reasonCodes, REASON_CODES.PROMPT_COMPACTION_EXHAUSTED])],
      splitApplied: false,
    };
  }

  const splitText = String(splitStrategy(firstPass.text) || "");
  const secondPass = compactPromptText(splitText, budget);
  if (secondPass.tokens <= budget) {
    return {
      ok: true,
      text: secondPass.text,
      estimatedTokens: secondPass.tokens,
      reasonCodes: [...new Set([...firstPass.reasonCodes, ...secondPass.reasonCodes])],
      splitApplied: true,
    };
  }

  return {
    ok: false,
    text: secondPass.text,
    estimatedTokens: secondPass.tokens,
    reasonCodes: [...new Set([...firstPass.reasonCodes, ...secondPass.reasonCodes, REASON_CODES.PROMPT_COMPACTION_EXHAUSTED])],
    splitApplied: true,
  };
}
