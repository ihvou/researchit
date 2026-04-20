import assert from "node:assert/strict";
import test from "node:test";

import { callActorJson, normalizeConfidence } from "../pipeline/stages/common.js";
import { runStage as run03b } from "../pipeline/stages/03b-evidence-web.js";
import { runStage as run03c } from "../pipeline/stages/03c-evidence-deep-assist.js";
import { runStage as run02 } from "../pipeline/stages/02-plan.js";
import { runStage as run05 } from "../pipeline/stages/05-score-confidence.js";
import { runStage as run06 } from "../pipeline/stages/06-source-verify.js";
import { runStage as run07 } from "../pipeline/stages/07-source-assess.js";
import { runStage as run08 } from "../pipeline/stages/08-recover.js";
import { runStage as run11 } from "../pipeline/stages/11-challenge.js";
import { runStage as run13 } from "../pipeline/stages/13-defend.js";
import { runStage as run14 } from "../pipeline/stages/14-synthesize.js";
import { runStage as run15 } from "../pipeline/stages/15-finalize.js";
import { classifyStageFailureCause, reasonCodesForUpstreamHash } from "../pipeline/orchestrator.js";
import { toUseCaseState } from "../pipeline/contracts/run-state.js";

function baseModels() {
  return {
    analyst: { provider: "openai", model: "gpt-5.4" },
    retrieval: { provider: "gemini", model: "gemini-2.5-pro" },
    critic: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  };
}

test("normalizeConfidence maps numeric scales and reports coercion", () => {
  const stats = { coerced: 0 };
  assert.equal(normalizeConfidence("high", stats), "high");
  assert.equal(normalizeConfidence(5, stats), "high");
  assert.equal(normalizeConfidence("3", stats), "medium");
  assert.equal(normalizeConfidence(2, stats), "low");
  assert.equal(normalizeConfidence(null, stats), "low");
  assert.equal(stats.coerced, 3);
});

test("callActorJson parse retry applies repair prompt and reduces scope", async () => {
  const prompts = [];
  const runtime = {
    transport: {
      callAnalyst: async (messages) => {
        const prompt = String(messages?.[0]?.content || "");
        prompts.push(prompt);
        if (prompts.length === 1) return { text: '{"broken":' };
        return { text: '{"ok":true}' };
      },
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
    config: { models: baseModels() },
  };
  const state = { mode: "native", config: runtime.config };

  const out = await callActorJson({
    state,
    runtime,
    stageId: "stage_test_parse_repair",
    actor: "analyst",
    systemPrompt: "system",
    userPrompt: "L1\nL2\nL3_DROP\nL4_DROP",
    schemaHint: '{"ok":true}',
    maxRetries: 1,
    timeoutMs: 5_000,
    tokenBudget: 4_000,
  });

  assert.equal(out?.parsed?.ok, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Previous response failed JSON parsing/i);
  assert.equal(prompts[1].includes("L4_DROP"), true);
  assert.equal(out?.tokenDiagnostics?.parseRepairApplied, true);
  assert.equal(out?.tokenDiagnostics?.parseRepairAttempts, 1);
  assert.equal(out?.tokenDiagnostics?.parseScopeReduced, false);
});

test("classifyStageFailureCause maps parse-truncation loops and timeout aborts", () => {
  const truncationCause = classifyStageFailureCause({
    stageId: "stage_03a_evidence_memory",
    reasonCodes: ["response_parse_failed", "truncation_suspected"],
    err: { message: "JSON parse failed", outputTruncated: true },
  });
  assert.equal(truncationCause?.type, "truncation_parse_loop");

  const timeoutCause = classifyStageFailureCause({
    stageId: "stage_03b_evidence_web",
    reasonCodes: ["stage_timeout"],
    err: { abortReason: { source: "provider_timeout" }, message: "timed out" },
  });
  assert.equal(timeoutCause?.type, "network_timeout");
});

test("toUseCaseState exposes safetyGuardrails in analysisMeta", () => {
  const uc = toUseCaseState({
    runId: "run-guardrail",
    outputType: "scorecard",
    mode: "native",
    ui: { rawInput: "Test objective", status: "error", phase: "stage_03a_evidence_memory" },
    request: {
      titleHint: "Test",
      researchConfigId: "default",
      scorecard: { dimensions: [] },
    },
    config: { name: "Default" },
    quality: {
      qualityGrade: "failed",
      reasonCodes: ["response_parse_failed"],
      safetyGuardrails: [{
        type: "parse_failure_aborted",
        stageId: "stage_03a_evidence_memory",
        severity: "fatal",
        status: "aborted",
        attempts: 2,
        scopeReduced: true,
        truncationSuspected: true,
        reasonCode: "response_parse_failed",
        detail: "stage_03a_evidence_memory parse guardrail exhausted",
      }],
    },
    diagnostics: { stages: [] },
  });

  assert.equal(Array.isArray(uc?.analysisMeta?.safetyGuardrails), true);
  assert.equal(uc.analysisMeta.safetyGuardrails.length, 1);
  assert.equal(uc.analysisMeta.safetyGuardrails[0].type, "parse_failure_aborted");
});

test("reasonCodesForUpstreamHash excludes cache_hit when stage result is cached", () => {
  const fromCached = reasonCodesForUpstreamHash({
    fromCache: true,
    result: { reasonCodes: ["prompt_compaction_applied"] },
    reasonCodes: ["prompt_compaction_applied", "cache_hit"],
  });
  assert.deepEqual(fromCached, ["prompt_compaction_applied"]);

  const fromFresh = reasonCodesForUpstreamHash({
    fromCache: false,
    result: { reasonCodes: ["prompt_compaction_applied"] },
    reasonCodes: ["prompt_compaction_applied", "cache_hit"],
  });
  assert.deepEqual(fromFresh, ["prompt_compaction_applied", "cache_hit"]);
});

test("stage 03b matrix web pass adaptively splits chunks and preserves full cell coverage", async () => {
  const attrs = [
    { id: "attr-1", label: "Attribute 1" },
    { id: "attr-2", label: "Attribute 2" },
  ];
  const subjects = [
    { id: "sub-1", label: "Subject 1" },
    { id: "sub-2", label: "Subject 2" },
    { id: "sub-3", label: "Subject 3" },
    { id: "sub-4", label: "Subject 4" },
  ];

  const memoryCells = subjects.flatMap((subject) => attrs.map((attr) => ({
    subjectId: subject.id,
    attributeId: attr.id,
    value: "memory",
    confidence: "low",
    sources: [],
    arguments: { supporting: [], limiting: [] },
  })));

  const runtime = {
    config: {
      models: baseModels(),
      limits: { matrixWebChunkMaxCells: 4 },
    },
    budgets: {
      stage_03b_evidence_web: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { analyst: "web evidence" },
    transport: {
      callAnalyst: async (messages) => {
        const prompt = String(messages?.[0]?.content || "");
        const subjectIds = [...prompt.matchAll(/-\s*(sub-[a-z0-9_-]+)\s*:/gi)].map((m) => m[1]);
        const attributeIds = [...prompt.matchAll(/-\s*(attr-[a-z0-9_-]+)\s*:/gi)].map((m) => m[1]);

        if (subjectIds.length > 1) {
          throw new Error("chunk too large");
        }

        return {
          text: JSON.stringify({
            cells: subjectIds.flatMap((subjectId) => attributeIds.map((attributeId) => ({
              subjectId,
              attributeId,
              value: `web:${subjectId}:${attributeId}`,
              full: "web evidence",
              confidence: "medium",
              confidenceReason: "has web sources",
              sources: [{ name: "Source", url: "https://example.com" }],
              arguments: { supporting: [], limiting: [] },
              risks: "",
            }))),
          }),
        };
      },
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    outputType: "matrix",
    request: {
      objective: "compare subjects",
      matrix: { subjects, attributes: attrs },
    },
    evidenceDrafts: {
      memory: { matrix: { cells: memoryCells } },
    },
    mode: "native",
  };

  const result = await run03b({ state, runtime });
  const webCells = result?.statePatch?.evidenceDrafts?.web?.matrix?.cells || [];
  const mergedCells = result?.statePatch?.evidenceDrafts?.merged?.matrix?.cells || [];

  assert.equal(webCells.length, subjects.length * attrs.length);
  assert.equal(mergedCells.length, subjects.length * attrs.length);
  assert.ok((result?.diagnostics?.chunks || []).some((item) => Array.isArray(item?.splitInto)));
});

test("stage 03b marks grounded sources from provider metadata", async () => {
  const attrs = [{ id: "a1", label: "Attr 1" }];
  const subjects = [{ id: "s1", label: "Subject 1" }];
  const canonicalUrl = "https://example.com/canonical-source";

  const runtime = {
    config: {
      models: baseModels(),
      limits: { matrixWebChunkMaxCells: 4 },
    },
    budgets: {
      stage_03b_evidence_web: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { analyst: "web evidence" },
    transport: {
      callAnalyst: async () => ({
        text: JSON.stringify({
          cells: [{
            subjectId: "s1",
            attributeId: "a1",
            value: "value",
            full: "full",
            confidence: "medium",
            confidenceReason: "reason",
            sources: [{ name: "Grounded", url: canonicalUrl, sourceType: "news" }],
            arguments: { supporting: [], limiting: [] },
            risks: "",
          }],
        }),
        sources: [{ name: "Grounded", url: canonicalUrl, sourceType: "news" }],
      }),
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    outputType: "matrix",
    request: {
      objective: "compare subjects",
      matrix: { subjects, attributes: attrs },
    },
    evidenceDrafts: {
      memory: {
        matrix: {
          cells: [{
            subjectId: "s1",
            attributeId: "a1",
            value: "memory",
            confidence: "low",
            sources: [],
            arguments: { supporting: [], limiting: [] },
          }],
        },
      },
    },
    mode: "native",
  };

  const result = await run03b({ state, runtime });
  const source = result?.statePatch?.evidenceDrafts?.web?.matrix?.cells?.[0]?.sources?.[0] || {};
  const groundedRatio = Number(result?.diagnostics?.citations?.groundedRatio || 0);

  assert.equal(source.url, canonicalUrl);
  assert.equal(source.groundedByProvider, true);
  assert.equal(source.groundedSetAvailable, true);
  assert.equal(groundedRatio, 1);
});

test("stage 03c fails run when any Deep Research x3 provider fails (legacy alias mode, non-strict included)", async () => {
  const runtime = {
    config: {
      models: baseModels(),
      deepAssist: {
        defaults: { providers: ["chatgpt", "claude", "gemini"] },
        providers: {
          chatgpt: { analyst: { provider: "openai", model: "gpt-5.4" } },
          claude: { analyst: { provider: "anthropic", model: "claude-sonnet-4-20250514" } },
          gemini: { analyst: { provider: "gemini", model: "gemini-2.5-pro" } },
        },
      },
    },
    budgets: {
      stage_03c_evidence_deep_assist: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { analyst: "deep research x3" },
    transport: {
      callAnalyst: async (_messages, _system, _budget, options = {}) => {
        if (String(options?.provider || "").toLowerCase() === "anthropic") {
          throw new Error("provider down");
        }
        return {
          text: JSON.stringify({
            dimensions: [{ id: "dim-1", brief: "ok", full: "ok", confidence: "medium", sources: [] }],
          }),
        };
      },
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    mode: "deep-assist",
    strictQuality: false,
    outputType: "scorecard",
    request: {
      objective: "test",
      scorecard: {
        dimensions: [{ id: "dim-1", label: "Dimension 1" }],
      },
    },
  };

  await assert.rejects(() => run03c({ state, runtime }), /provider down/i);
});

test("stage 08 reserves per-attribute recovery floor before pressure fill", async () => {
  const runtime = {
    config: {
      models: baseModels(),
      limits: { matrixAdaptiveTargetedMax: 1 },
    },
    budgets: {
      stage_08_recover: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { analyst: "recover" },
    transport: {
      callAnalyst: async (messages) => {
        const prompt = String(messages?.[0]?.content || "");
        const ids = [...prompt.matchAll(/-\s*([a-z0-9_-]+)::([a-z0-9_-]+)/gi)]
          .map((m) => ({ subjectId: m[1], attributeId: m[2] }));
        return {
          text: JSON.stringify({
            cells: ids.map((id) => ({
              ...id,
              value: "recovered",
              full: "recovered evidence",
              confidence: "medium",
              confidenceReason: "new web sources",
              sources: [{ name: "Recovered", url: "https://example.com/recovered" }],
              arguments: { supporting: [], limiting: [] },
              risks: "",
            })),
          }),
        };
      },
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    outputType: "matrix",
    mode: "native",
    request: { objective: "recover matrix" },
    assessment: {
      matrix: {
        cells: [
          { subjectId: "s1", attributeId: "a1", confidence: "low", sources: [] },
          { subjectId: "s2", attributeId: "a1", confidence: "high", sources: [{ name: "x" }] },
          { subjectId: "s1", attributeId: "a2", confidence: "low", sources: [] },
          { subjectId: "s2", attributeId: "a2", confidence: "high", sources: [{ name: "x" }] },
        ],
      },
    },
  };

  const result = await run08({ state, runtime });

  assert.equal(result?.diagnostics?.requestedBudget, 1);
  assert.equal(result?.diagnostics?.attributeCoverageFloorReserved, 2);
  assert.equal(result?.diagnostics?.effectiveBudget, 2);
  assert.equal(result?.statePatch?.recoveredPatch?.matrix?.cells?.length, 2);
});

test("stage 06 applies verification tiers and isolates infrastructure noise", async () => {
  const runtime = {
    transport: {
      fetchSource: async (url, options = {}) => {
        const value = String(url || "");
        if (value.includes("vendor.example")) {
          return {
            url: value,
            resolvedUrl: value,
            responseStatus: 403,
            reachable: false,
            sourceFetchStatus: "403",
          };
        }
        if (value.includes("analyst.example")) {
          return {
            url: value,
            resolvedUrl: value,
            responseStatus: 403,
            reachable: false,
            sourceFetchStatus: "403",
          };
        }
        if (value.includes("research.example")) {
          const err = new Error("fetch failed");
          err.sourceFetchStatus = "fetch_failed";
          throw err;
        }
        return {
          url: value,
          resolvedUrl: value,
          responseStatus: 200,
          reachable: true,
          sourceFetchStatus: "resolved",
          text: "evidence text",
        };
      },
    },
  };

  const state = {
    outputType: "matrix",
    assessment: {
      matrix: {
        cells: [{
          subjectId: "s1",
          attributeId: "a1",
          confidence: "medium",
          sources: [
            { name: "Vendor", url: "https://vendor.example/page", sourceType: "vendor" },
            { name: "Analyst", url: "https://analyst.example/report", sourceType: "analyst" },
            { name: "Research", url: "https://research.example/paper", sourceType: "research", quote: "trial result" },
          ],
          arguments: { supporting: [], limiting: [] },
        }],
      },
    },
  };

  const result = await run06({ state, runtime });
  const counters = result?.diagnostics?.counters || {};
  const sources = result?.statePatch?.assessment?.matrix?.cells?.[0]?.sources || [];

  assert.equal(counters.fetchFailed, 1);
  assert.equal(counters.paywalled, 1);
  assert.equal(counters.unverifiable, 2);
  assert.equal(counters.verificationTierCounts?.unreachableInfrastructure, 3);
  assert.equal(counters.verificationTierCounts?.fabricated, 0);
  assert.equal(sources.find((s) => s.sourceType === "vendor")?.verificationStatus, "unverifiable");
  assert.equal(sources.find((s) => s.sourceType === "analyst")?.verificationStatus, "paywalled");
  assert.equal(sources.find((s) => s.sourceType === "research")?.verificationStatus, "fetch_failed");
  assert.equal(sources.find((s) => s.sourceType === "vendor")?.verificationTier, "unreachable_infrastructure");
  assert.equal(sources.find((s) => s.sourceType === "analyst")?.verificationTier, "unreachable_infrastructure");
  assert.equal(sources.find((s) => s.sourceType === "research")?.verificationTier, "unreachable_infrastructure");
});

test("stage 07 preserves model confidence and sets citation status separately", async () => {
  const state = {
    outputType: "matrix",
    assessment: {
      matrix: {
        cells: [{
          subjectId: "s1",
          attributeId: "a1",
          confidence: "high",
          confidenceSource: "model",
          confidenceReason: "Model has strong prior knowledge.",
          sources: [
            { name: "Vendor page", sourceType: "vendor", verificationStatus: "unverifiable", citationStatus: "unverifiable" },
            { name: "News", sourceType: "news", verificationStatus: "not_found_in_page", citationStatus: "not_found" },
          ],
          arguments: { supporting: [], limiting: [] },
        }],
      },
    },
  };

  const result = await run07({ state });
  const cell = result?.statePatch?.assessment?.matrix?.cells?.[0] || {};

  assert.equal(cell.confidence, "high");
  assert.equal(cell.confidenceSource, "model");
  assert.equal(cell.citationStatus, "unverifiable");
});

test("stage 14 compact critic summary marks counterCaseChangedFinalUnits only on actual diffs", async () => {
  const prompts = [];
  const runtime = {
    config: { models: baseModels() },
    budgets: {
      stage_14_synthesize: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { analystSynthesis: "synth" },
    transport: {
      callAnalyst: async (messages) => {
        const prompt = String(messages?.[0]?.content || "");
        prompts.push(prompt);
        return {
          text: JSON.stringify({
            executiveSummary: "summary",
            decisionImplication: "implication",
            dissent: "dissent",
          }),
        };
      },
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const beforeCells = [{ subjectId: "s1", attributeId: "a1", value: "same", confidence: "medium" }];
  const afterCells = [{ subjectId: "s1", attributeId: "a1", value: "same", confidence: "medium" }];

  const state = {
    outputType: "matrix",
    request: { objective: "objective", decisionQuestion: "question" },
    critique: {
      flags: [{ id: "f1", severity: "high", note: "flag note" }],
      counterCase: { entries: [{ unitKey: "s1::a1", note: "counter" }] },
    },
    assessment: { matrix: { cells: beforeCells } },
    resolved: {
      assessment: { matrix: { cells: afterCells } },
      flagOutcomes: [{ flagId: "f1", resolved: true, flag: { severity: "high" } }],
    },
    mode: "native",
  };

  await run14({ state, runtime });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /"counterCaseChangedFinalUnits":false/);
});

test("stage 05 scorecard uses rubric-aware model scoring contract", async () => {
  const prompts = [];
  const runtime = {
    config: { models: baseModels() },
    budgets: {
      stage_05_score_confidence: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { analyst: "scorer" },
    transport: {
      callAnalyst: async (messages) => {
        const prompt = String(messages?.[0]?.content || "");
        prompts.push(prompt);
        return {
          text: JSON.stringify({
            units: [{
              unitId: "problem-severity",
              score: 4,
              confidence: "medium",
              confidenceReason: "Rubric-aligned evidence depth is moderate.",
              brief: "Validated pain appears meaningful.",
              full: "Evidence indicates recurring pain with moderate severity.",
              missingEvidence: "Needs independent cohort-level quantification.",
            }],
          }),
        };
      },
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    outputType: "scorecard",
    request: {
      objective: "validate startup pain",
      decisionQuestion: "is pain strong enough",
      scorecard: {
        dimensions: [{
          id: "problem-severity",
          label: "Problem Severity",
          brief: "How painful and frequent the target problem is.",
          rubric: "5 strong recurring behavioral evidence; 1 weak anecdotal signal.",
          weight: 20,
        }],
      },
    },
    evidence: {
      scorecard: {
        dimensions: [{
          id: "problem-severity",
          brief: "Pain appears material for selected users.",
          full: "Interviews and behavior logs suggest repeated pain episodes.",
          confidence: "low",
          confidenceReason: "Few independent sources.",
          sources: [{ name: "Interview notes", url: "https://example.com/notes" }],
          arguments: { supporting: [{ claim: "Users repeatedly hit this blocker." }], limiting: [] },
          risks: "",
        }],
      },
    },
    mode: "native",
  };

  const result = await run05({ state, runtime });
  const unit = result?.statePatch?.assessment?.scorecard?.byId?.["problem-severity"];

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /rubric anchors/i);
  assert.match(prompts[0], /5 strong recurring behavioral evidence/i);
  assert.equal(unit?.score, 4);
  assert.equal(unit?.confidence, "medium");
  assert.equal(unit?.missingEvidence, "Needs independent cohort-level quantification.");
});

test("stage 11 matrix challenge prompt is mode-aware and ignores suggestedScore", async () => {
  const prompts = [];
  const runtime = {
    config: { models: baseModels() },
    budgets: {
      stage_11_challenge: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { critic: "critic" },
    transport: {
      callCritic: async (messages) => {
        const prompt = String(messages?.[0]?.content || "");
        prompts.push(prompt);
        return {
          text: JSON.stringify({
            flags: [{
              id: "flag-1",
              unitKey: "s1::a1",
              flagType: "factual",
              severity: "high",
              category: "overclaim",
              note: "Value overstates evidence certainty.",
              suggestedScore: 1,
              suggestedValue: "insufficient evidence",
              suggestedConfidence: "low",
              sources: [],
            }],
          }),
        };
      },
      callAnalyst: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    outputType: "matrix",
    request: { objective: "matrix review" },
    assessment: {
      matrix: {
        cells: [{
          subjectId: "s1",
          attributeId: "a1",
          value: "strong fit",
          full: "Claim text",
          confidence: "high",
          confidenceReason: "single source",
          sources: [{ name: "Source", url: "https://example.com" }],
          arguments: { supporting: [], limiting: [] },
        }],
      },
    },
    critique: { coherenceFindings: [{ unitKey: "s1::a1", note: "possible overclaim" }] },
    mode: "native",
  };

  const result = await run11({ state, runtime });
  const flag = result?.statePatch?.critique?.flags?.[0] || {};

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /do not return suggestedScore/i);
  assert.match(prompts[0], /factual accuracy pass/i);
  assert.equal(flag?.suggestedValue, "insufficient evidence");
  assert.equal(flag?.suggestedScore, undefined);
  assert.equal(flag?.flagType, "factual");
});

test("stage 02 does not fail on matrix cell-level planner ids and reports diagnostics", async () => {
  const runtime = {
    config: { models: baseModels() },
    budgets: {
      stage_02_plan: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 6_000 },
    },
    prompts: { analyst: "planner" },
    transport: {
      callAnalyst: async () => ({
        text: JSON.stringify({
          niche: "niche",
          aliases: ["alias"],
          units: [{
            unitId: "subject-1::attribute-1",
            supportingQueries: ["bad"],
            counterfactualQueries: ["bad"],
            sourceTargets: ["bad"],
            gapHypothesis: "bad",
          }],
        }),
      }),
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    outputType: "matrix",
    request: {
      outputType: "matrix",
      objective: "plan objective",
      matrix: {
        attributes: [{ id: "attribute-1", label: "Attribute 1", brief: "brief" }],
      },
    },
    mode: "native",
  };

  const result = await run02({ state, runtime });
  assert.equal(result?.stageStatus, "ok");
  assert.deepEqual(result?.diagnostics?.discardedCellLevelUnitIds, ["subject-1::attribute-1"]);
  assert.equal(result?.statePatch?.plan?.units?.[0]?.unitId, "attribute-1");
});

test("stage 13 marks omitted flag outcomes as no_response without fabricated dismissal", async () => {
  const runtime = {
    config: { models: baseModels() },
    budgets: {
      stage_13_defend: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { analystResponse: "defend" },
    transport: {
      callAnalyst: async () => ({
        text: JSON.stringify({
          outcomes: [{
            flagId: "flag-1",
            resolved: true,
            disposition: "accepted",
            analystNote: "Accepted and adjusted.",
            sources: [],
          }],
          analystSummary: "summary",
        }),
      }),
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    outputType: "scorecard",
    assessment: {
      scorecard: {
        byId: {
          dim1: { id: "dim1", score: 3, confidence: "medium" },
          dim2: { id: "dim2", score: 3, confidence: "medium" },
        },
      },
    },
    critique: {
      flags: [
        { id: "flag-1", unitKey: "dim1", severity: "medium", category: "overclaim", note: "n1" },
        { id: "flag-2", unitKey: "dim2", severity: "high", category: "missing_evidence", note: "n2" },
      ],
      counterCase: { entries: [] },
    },
    mode: "native",
  };

  const result = await run13({ state, runtime });
  const outcomes = result?.statePatch?.resolved?.flagOutcomes || [];
  const omitted = outcomes.find((item) => item?.flagId === "flag-2");

  assert.equal(outcomes.length, 2);
  assert.equal(omitted?.resolved, false);
  assert.equal(omitted?.disposition, "no_response");
  assert.equal(omitted?.responseMissing, true);
  assert.match(String(omitted?.analystNote || ""), /No analyst response returned/i);
});

test("stage 13 keeps resolved outcomes when analyst note is missing and emits reason code", async () => {
  const runtime = {
    config: { models: baseModels() },
    budgets: {
      stage_13_defend: { retryMax: 0, timeoutMs: 10_000, tokenBudget: 8_000 },
    },
    prompts: { analystResponse: "defend" },
    transport: {
      callAnalyst: async () => ({
        text: JSON.stringify({
          outcomes: [{
            flagId: "flag-1",
            resolved: true,
            disposition: "accepted",
            analystNote: "",
            sources: [],
          }],
          analystSummary: "summary",
        }),
      }),
      callCritic: async () => ({ text: '{"ok":true}' }),
      callSynthesizer: async () => ({ text: '{"ok":true}' }),
    },
  };

  const state = {
    outputType: "scorecard",
    assessment: {
      scorecard: {
        byId: {
          dim1: { id: "dim1", score: 3, confidence: "medium" },
        },
      },
    },
    critique: {
      flags: [
        { id: "flag-1", unitKey: "dim1", severity: "medium", category: "overclaim", note: "n1" },
      ],
      counterCase: { entries: [] },
    },
    mode: "native",
  };

  const result = await run13({ state, runtime });
  const outcome = result?.statePatch?.resolved?.flagOutcomes?.[0] || {};

  assert.equal(outcome.resolved, true);
  assert.equal(outcome.disposition, "accepted");
  assert.match(String(outcome.analystNote || ""), /resolution without note/i);
  assert.ok((result?.reasonCodes || []).includes("defend_note_missing"));
});

test("stage 15 strict mode never emits run_completed_degraded", async () => {
  const state = {
    strictQuality: true,
    outputType: "scorecard",
    assessment: {
      scorecard: {
        byId: {
          dim1: {
            id: "dim1",
            score: 3,
            confidence: "low",
            sources: [],
          },
        },
      },
    },
    resolved: {
      assessment: {
        scorecard: {
          byId: {
            dim1: {
              id: "dim1",
              score: 3,
              confidence: "low",
              sources: [],
            },
          },
        },
      },
      flagOutcomes: [],
    },
  };
  const runtime = {
    config: {
      quality: { hardAbortCoverageFloor: 0.0 },
      limits: {
        matrixDecisionGradeGate: {
          minCoverageRatio: 1,
          maxLowConfidenceRatio: 0,
          minSourcesPerCriticalUnit: 10,
          minIndependentSourcesPerCriticalUnit: 10,
          maxUnresolvedCriticFlags: 0,
        },
      },
    },
  };

  const result = await run15({ state, runtime });
  assert.equal(result?.reasonCodes?.includes("run_completed_degraded"), false);
});

test("stage 15 classifies quality failure causes in diagnostics", async () => {
  const state = {
    strictQuality: true,
    outputType: "scorecard",
    assessment: {
      scorecard: {
        byId: {
          dim1: {
            id: "dim1",
            score: 3,
            confidence: "low",
            sources: [
              { sourceType: "research", verificationTier: "fabricated", citationStatus: "not_found" },
            ],
          },
        },
      },
    },
    resolved: {
      assessment: {
        scorecard: {
          byId: {
            dim1: {
              id: "dim1",
              score: 3,
              confidence: "low",
              sources: [
                { sourceType: "research", verificationTier: "fabricated", citationStatus: "not_found" },
              ],
            },
          },
        },
      },
      flagOutcomes: [],
    },
    diagnostics: {
      stages: [{
        stage: "stage_03b_evidence_web",
        reasonCodes: ["confidence_scale_coerced"],
      }],
    },
  };
  const runtime = {
    config: {
      quality: { hardAbortCoverageFloor: 0.0 },
      limits: {
        matrixDecisionGradeGate: {
          minCoverageRatio: 0.5,
          maxLowConfidenceRatio: 0,
          minSourcesPerCriticalUnit: 1,
          minIndependentSourcesPerCriticalUnit: 0,
          maxUnresolvedCriticFlags: 0,
          maxUnverifiedSourceRatio: 1,
          maxFabricatedSourceRatio: 0.01,
        },
      },
    },
  };

  const result = await run15({ state, runtime });
  const causes = result?.statePatch?.quality?.failureCauses || [];
  const types = causes.map((cause) => cause?.type);

  assert.ok(types.includes("fabrication"));
  assert.ok(types.includes("pipeline_coercion"));
  assert.ok(types.includes("data_gap"));
});
