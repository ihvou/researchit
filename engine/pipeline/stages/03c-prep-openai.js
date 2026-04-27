import {
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
} from "./common.js";
import { REASON_CODES, normalizeReasonCodes } from "../contracts/reason-codes.js";

const STAGE_ID = "stage_03c_evidence_deep_assist";
const PREP_CLARIFY_STAGE_ID = "stage_03c_openai_deep_research_clarify";
const PREP_REWRITE_STAGE_ID = "stage_03c_openai_deep_research_rewrite";

function envValue(name = "") {
  return globalThis?.process?.env?.[name];
}

function envFlag(name = "", fallback = true) {
  const raw = clean(envValue(name)).toLowerCase();
  if (!raw) return fallback;
  if (["0", "false", "off", "no", "disabled"].includes(raw)) return false;
  if (["1", "true", "on", "yes", "enabled"].includes(raw)) return true;
  return fallback;
}

function configFlag(value, fallback) {
  if (typeof value === "boolean") return value;
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  if (["0", "false", "off", "no", "disabled"].includes(raw)) return false;
  if (["1", "true", "on", "yes", "enabled"].includes(raw)) return true;
  return fallback;
}

function prepConfig(runtime = {}, state = {}) {
  const config = runtime?.config || state?.config || {};
  return config?.deepAssist?.openaiPrep && typeof config.deepAssist.openaiPrep === "object"
    ? config.deepAssist.openaiPrep
    : {};
}

function prepEnabled(runtime = {}, state = {}) {
  const fromEnv = envFlag("RESEARCHIT_DEEP_RESEARCH_X3_OPENAI_CLARIFY", true);
  return configFlag(prepConfig(runtime, state)?.enabled, fromEnv);
}

function prepModel(runtime = {}, state = {}, key = "", fallback = "") {
  const cfg = prepConfig(runtime, state);
  const envName = key === "rewriteModel"
    ? "RESEARCHIT_DEEP_RESEARCH_X3_OPENAI_REWRITE_MODEL"
    : "RESEARCHIT_DEEP_RESEARCH_X3_OPENAI_CLARIFY_MODEL";
  return clean(cfg?.[key]) || clean(envValue(envName)) || fallback;
}

function prepTimeoutMs(runtime = {}, state = {}) {
  const cfg = prepConfig(runtime, state);
  return Number(cfg?.timeoutMs || runtime?.budgets?.[STAGE_ID]?.openaiPrepTimeoutMs || 60_000) || 60_000;
}

function prepRetryMax(runtime = {}, state = {}) {
  const cfg = prepConfig(runtime, state);
  return Number.isFinite(Number(cfg?.retryMax)) ? Math.max(0, Number(cfg.retryMax)) : 1;
}

function sanitizeQuestions(parsed = {}) {
  const raw = ensureArray(parsed?.questions);
  return raw
    .map((item) => {
      if (typeof item === "string") return { question: clean(item), why: "" };
      return {
        question: clean(item?.question),
        why: clean(item?.why || item?.rationale),
      };
    })
    .filter((item) => item.question)
    .slice(0, 3);
}

function sanitizeAnswers(parsed = {}, questions = []) {
  const raw = ensureArray(parsed?.answers || parsed?.clarificationAnswers || parsed?.inferredAnswers);
  const byQuestion = new Map(raw.map((item) => [clean(item?.question), item]));
  return questions.map((question) => {
    const match = byQuestion.get(question.question) || raw.find((item) => clean(item?.question).toLowerCase() === question.question.toLowerCase()) || {};
    return {
      question: question.question,
      answer: clean(match?.answer),
      basis: clean(match?.basis || match?.source || "inferred_from_request"),
    };
  }).filter((item) => item.question && item.answer);
}

function throwPrepError(message = "OpenAI Deep Research prep failed.", extra = {}) {
  const err = new Error(message);
  err.reasonCode = REASON_CODES.OPENAI_DEEP_RESEARCH_PREP_FAILED;
  Object.assign(err, extra);
  throw err;
}

function buildClarificationPrompt(basePrompt = "") {
  return `You are preparing a ChatGPT Deep Research run for an autonomous ResearchIt pipeline.

Read the research request below and identify the 1-3 clarification questions a careful human research analyst would ask before starting. Focus on scope, time horizon, geography/market, decision frame, inclusion/exclusion boundaries, and evidence standards.

Do not ask questions whose answers are already explicit. Do not answer the questions here.

Research request:
${basePrompt}

Return strict JSON only:
{"questions":[{"question":"","why":""}]}`;
}

function buildRewritePrompt({ basePrompt = "", questions = [] } = {}) {
  return `You are the autonomous clarification and prompt-rewriting step that ChatGPT Deep Research API callers must replicate.

Use the original research request and the clarification questions below. Infer practical answers only from the supplied request and ResearchIt plan context. If the input does not answer a question, state a conservative assumption instead of inventing a new fact.

Then rewrite the request into a fully-formed Deep Research brief for o3-deep-research. The rewritten prompt must be more explicit than the original, preserve every required subject/dimension/cell, preserve the JSON output contract, and ask for decision-grade evidence with citations.

Clarification questions:
${questions.map((q, idx) => `${idx + 1}. ${q.question}${q.why ? ` (${q.why})` : ""}`).join("\n")}

Original research request:
${basePrompt}

Return strict JSON only:
{"answers":[{"question":"","answer":"","basis":""}],"rewrittenPrompt":"","assumptions":[]}`;
}

function buildFinalPrompt({ basePrompt = "", rewrittenPrompt = "", answers = [], assumptions = [] } = {}) {
  const answerLines = answers
    .map((item) => `- ${item.question}: ${item.answer}${item.basis ? ` (basis: ${item.basis})` : ""}`)
    .join("\n");
  const assumptionLines = ensureArray(assumptions).map((item) => clean(item)).filter(Boolean).map((item) => `- ${item}`).join("\n");
  const parts = [
    "Deep Research brief prepared after autonomous clarification:",
    clean(rewrittenPrompt),
  ];
  if (answerLines) {
    parts.push("Clarification answers inferred from the supplied request and plan context:", answerLines);
  }
  if (assumptionLines) {
    parts.push("Conservative assumptions to respect during research:", assumptionLines);
  }
  parts.push(
    "Authoritative ResearchIt coverage and output contract. Preserve this exactly if it conflicts with the rewritten brief:",
    basePrompt
  );
  return parts.filter(Boolean).join("\n\n").trim();
}

export function isOpenAIDeepResearchProvider(providerId = "", routeOverride = {}) {
  const providerKey = clean(providerId).toLowerCase();
  const routeProvider = clean(routeOverride?.provider).toLowerCase();
  return providerKey === "chatgpt" || providerKey === "openai" || routeProvider === "openai";
}

export async function prepareOpenAIDeepResearchPrompt({
  state,
  runtime,
  providerId = "chatgpt",
  basePrompt = "",
  routeOverride = {},
} = {}) {
  const originalPrompt = clean(basePrompt);
  if (!originalPrompt) {
    throwPrepError("OpenAI Deep Research prep received an empty base prompt.");
  }

  if (!prepEnabled(runtime, state)) {
    return {
      prompt: originalPrompt,
      diagnostics: {
        prepUsed: false,
        skipped: true,
        reason: REASON_CODES.OPENAI_DEEP_RESEARCH_PREP_SKIPPED,
        originalPromptChars: originalPrompt.length,
        rewrittenPromptChars: originalPrompt.length,
        toolsEnabled: ["web_search_preview", "code_interpreter"],
      },
      reasonCodes: [REASON_CODES.OPENAI_DEEP_RESEARCH_PREP_SKIPPED],
      tokenDiagnostics: null,
    };
  }

  const clarificationModel = prepModel(runtime, state, "clarificationModel", "gpt-5.4-mini");
  const rewriteModel = prepModel(runtime, state, "rewriteModel", "gpt-4.1");
  const timeoutMs = prepTimeoutMs(runtime, state);
  const maxRetries = prepRetryMax(runtime, state);
  const provider = clean(routeOverride?.provider) || "openai";

  const clarification = await callActorJson({
    state,
    runtime,
    stageId: PREP_CLARIFY_STAGE_ID,
    routeStageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: "You write concise clarification questions for strategic Deep Research requests. Return strict JSON only.",
    userPrompt: buildClarificationPrompt(originalPrompt),
    tokenBudget: 1400,
    timeoutMs,
    maxRetries,
    liveSearch: false,
    deepResearch: false,
    routeOverride: {
      provider,
      model: clarificationModel,
      webSearchModel: clarificationModel,
    },
    schemaHint: '{"questions":[{"question":"","why":""}]}',
    callContext: {
      chunkId: `${providerId}-openai-prep-clarify`,
      promptVersion: "v1",
    },
  });

  const questions = sanitizeQuestions(clarification?.parsed || {});
  if (!questions.length) {
    throwPrepError("OpenAI Deep Research prep did not return clarification questions.", {
      prepStep: "clarification",
      payload: clarification?.parsed,
    });
  }

  const rewrite = await callActorJson({
    state,
    runtime,
    stageId: PREP_REWRITE_STAGE_ID,
    routeStageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: "You infer answers from supplied context and rewrite strategic Deep Research prompts. Return strict JSON only.",
    userPrompt: buildRewritePrompt({ basePrompt: originalPrompt, questions }),
    tokenBudget: 3200,
    timeoutMs,
    maxRetries,
    liveSearch: false,
    deepResearch: false,
    routeOverride: {
      provider,
      model: rewriteModel,
      webSearchModel: rewriteModel,
    },
    schemaHint: '{"answers":[{"question":"","answer":"","basis":""}],"rewrittenPrompt":"","assumptions":[]}',
    callContext: {
      chunkId: `${providerId}-openai-prep-rewrite`,
      promptVersion: "v1",
    },
  });

  const rewrittenPrompt = clean(rewrite?.parsed?.rewrittenPrompt);
  if (!rewrittenPrompt) {
    throwPrepError("OpenAI Deep Research prep did not return a rewritten prompt.", {
      prepStep: "rewrite",
      payload: rewrite?.parsed,
    });
  }
  const answers = sanitizeAnswers(rewrite?.parsed || {}, questions);
  if (answers.length !== questions.length) {
    throwPrepError("OpenAI Deep Research prep did not answer every clarification question.", {
      prepStep: "rewrite",
      questions,
      answers,
    });
  }
  const assumptions = ensureArray(rewrite?.parsed?.assumptions).map((item) => clean(item)).filter(Boolean);
  const finalPrompt = buildFinalPrompt({
    basePrompt: originalPrompt,
    rewrittenPrompt,
    answers,
    assumptions,
  });
  if (finalPrompt.length <= originalPrompt.length) {
    throwPrepError("OpenAI Deep Research rewritten prompt was not more explicit than the original.", {
      prepStep: "rewrite",
      originalPromptChars: originalPrompt.length,
      rewrittenPromptChars: finalPrompt.length,
    });
  }

  return {
    prompt: finalPrompt,
    diagnostics: {
      prepUsed: true,
      clarificationModel,
      rewriteModel,
      clarificationQuestions: questions,
      clarificationAnswers: answers,
      assumptions,
      originalPromptChars: originalPrompt.length,
      modelRewrittenPromptChars: rewrittenPrompt.length,
      rewrittenPromptChars: finalPrompt.length,
      toolsEnabled: ["web_search_preview", "code_interpreter"],
      rawResponses: {
        clarification: clean(clarification?.text),
        rewrite: clean(rewrite?.text),
      },
    },
    reasonCodes: normalizeReasonCodes([
      ...(clarification?.reasonCodes || []),
      ...(rewrite?.reasonCodes || []),
    ]),
    tokenDiagnosticsBreakdown: [
      {
        phase: "openai_deep_research_prep_clarify",
        ...clarification?.tokenDiagnostics,
      },
      {
        phase: "openai_deep_research_prep_rewrite",
        ...rewrite?.tokenDiagnostics,
      },
    ].filter((item) => item && typeof item === "object"),
    tokenDiagnostics: combineTokenDiagnostics([
      clarification?.tokenDiagnostics,
      rewrite?.tokenDiagnostics,
    ].filter(Boolean)),
  };
}
