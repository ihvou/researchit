import assert from "node:assert/strict";
import test from "node:test";
import { runRoutePreflight } from "../lib/routing/route-preflight.js";

test("route preflight fails when retrieval stage is not gemini", () => {
  const state = { mode: "native" };
  const config = {
    models: {
      analyst: { provider: "openai", model: "gpt-5.4" },
      critic: { provider: "anthropic", model: "claude-sonnet-4-6" },
      retrieval: { provider: "openai", model: "gpt-5.4" },
      synthesizer: { provider: "gemini", model: "gemini-2.5-pro" },
    },
  };

  assert.throws(
    () => runRoutePreflight({ state, config }),
    /route mismatch/i
  );
});

test("route preflight fails deep-research-x3 preflight when required provider is missing (legacy alias mode)", () => {
  const state = { mode: "deep-assist" };
  const config = {
    models: {
      analyst: { provider: "openai", model: "gpt-5.4" },
      critic: { provider: "anthropic", model: "claude-sonnet-4-6" },
      retrieval: { provider: "gemini", model: "gemini-2.5-pro" },
      synthesizer: { provider: "gemini", model: "gemini-2.5-pro" },
    },
    deepAssist: {
      defaults: { providers: ["chatgpt", "claude"] },
      providers: {
        chatgpt: { analyst: { provider: "openai", model: "gpt-5.4" } },
        claude: { analyst: { provider: "anthropic", model: "claude-sonnet-4-6" } },
      },
    },
  };

  assert.throws(
    () => runRoutePreflight({ state, config }),
    /missing deep research/i
  );
});
