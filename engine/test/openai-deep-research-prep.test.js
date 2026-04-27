import test from "node:test";
import assert from "node:assert/strict";

import {
  prepareOpenAIDeepResearchPrompt,
} from "../pipeline/stages/03c-prep-openai.js";

function baseRuntime() {
  const calls = [];
  return {
    calls,
    runtime: {
      config: {
        models: {
          analyst: { provider: "openai", model: "gpt-5.4" },
          critic: { provider: "anthropic", model: "claude-sonnet-4-6" },
          retrieval: { provider: "gemini", model: "gemini-2.5-pro" },
        },
        deepAssist: {
          openaiPrep: {
            enabled: true,
            clarificationModel: "gpt-5.4-mini",
            rewriteModel: "gpt-4.1",
          },
        },
      },
      transport: {
        callAnalyst: async (messages, _systemPrompt, _budget, options = {}) => {
          calls.push({
            chunkId: options?.chunkId,
            model: options?.model,
            provider: options?.provider,
            prompt: String(messages?.[0]?.content || ""),
          });
          if (String(options?.chunkId || "").includes("clarify")) {
            return {
              text: JSON.stringify({
                questions: [
                  { question: "What geography should the research prioritize?", why: "Geography affects vendors and regulation." },
                  { question: "What decision horizon should the evidence support?", why: "Time horizon changes source recency expectations." },
                ],
              }),
              meta: {
                providerId: "openai",
                model: options?.model,
                usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
              },
            };
          }
          return {
            text: JSON.stringify({
              answers: [
                { question: "What geography should the research prioritize?", answer: "Prioritize the United States because the original brief references US hospitals.", basis: "from_user_input" },
                { question: "What decision horizon should the evidence support?", answer: "Focus on current adoption and near-term buying evidence.", basis: "conservative_assumption" },
              ],
              rewrittenPrompt: "Run a deep, source-backed US healthcare vendor assessment with explicit attention to current hospital buying evidence, integration workflow, penalties, and adoption signals.",
              assumptions: ["Treat unspecified timing as current-to-near-term evidence."],
            }),
            meta: {
              providerId: "openai",
              model: options?.model,
              usage: { inputTokens: 120, outputTokens: 90, totalTokens: 210 },
            },
          };
        },
        callCritic: async () => ({ text: "{}" }),
        callSynthesizer: async () => ({ text: "{}" }),
      },
    },
  };
}

test("OpenAI Deep Research prep clarifies, rewrites, and preserves the output contract", async () => {
  const { runtime, calls } = baseRuntime();
  const originalPrompt = `Objective: Compare predictive readmission risk platforms.
Subjects:
- epic: Epic Predictive Risk
Attributes:
- workflow: Workflow integration

Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","sources":[]}]}`;

  const result = await prepareOpenAIDeepResearchPrompt({
    state: {
      mode: "deep-research-x3",
      config: runtime.config,
      request: { objective: "Compare predictive readmission risk platforms." },
    },
    runtime,
    providerId: "chatgpt",
    basePrompt: originalPrompt,
    routeOverride: { provider: "openai", model: "o3-deep-research" },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "gpt-5.4-mini");
  assert.equal(calls[1].model, "gpt-4.1");
  assert.equal(result.diagnostics.prepUsed, true);
  assert.equal(result.diagnostics.clarificationQuestions.length, 2);
  assert.equal(result.diagnostics.clarificationAnswers.length, 2);
  assert.equal(result.diagnostics.rewrittenPromptChars > result.diagnostics.originalPromptChars, true);
  assert.deepEqual(result.diagnostics.toolsEnabled, ["web_search_preview", "code_interpreter"]);
  assert.match(result.prompt, /Return JSON/);
  assert.match(result.prompt, /Epic Predictive Risk/);
  assert.equal(result.tokenDiagnostics.inputTokens, 220);
  assert.equal(result.tokenDiagnostics.outputTokens, 140);
});
