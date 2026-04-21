import test from "node:test";
import assert from "node:assert/strict";

import { runStage as runFinalize } from "../pipeline/stages/15-finalize.js";
import { buildDebugBundle } from "../lib/diagnostics/debug-bundle.js";

function mkState() {
  return {
    runId: "run-debug-contract",
    strictQuality: true,
    outputType: "matrix",
    quality: {
      reasonCodes: [],
      sourceVerification: {
        checked: 3,
        verified: 2,
        verificationTierCounts: {
          verified: 2,
          fabricated: 1,
          unreachableInfrastructure: 0,
          unreachableStale: 0,
          unverifiable: 0,
        },
      },
    },
    assessment: {
      matrix: {
        cells: [
          {
            subjectId: "s1",
            attributeId: "a1",
            confidence: "medium",
            sources: [
              {
                name: "Source 1",
                url: "https://example.com/1",
                verificationTier: "verified",
                sourceType: "independent",
                fabricationSignal: "low",
              },
              {
                name: "Source 2",
                url: "https://example.com/2",
                verificationTier: "fabricated",
                sourceType: "independent",
                fabricationSignal: "high",
              },
            ],
          },
        ],
      },
    },
    resolved: {
      flagOutcomes: [],
    },
    ui: {
      phase: "stage_15_finalize",
      status: "analyzing",
      errorMsg: null,
    },
    diagnostics: {
      run: {
        id: "run-debug-contract",
        mode: "native",
        outputType: "matrix",
      },
      stages: [],
      reasonCodes: [],
      quality: {},
    },
  };
}

test("decision-gate emission contract fields are present in stage output and debug bundle", async () => {
  const state = mkState();
  const result = await runFinalize({
    state,
    runtime: {
      config: {
        limits: {
          matrixDecisionGradeGate: {
            enabled: true,
            maxFabricatedSourceRatio: 0.5,
          },
        },
        quality: {
          hardAbortCoverageFloor: 0.1,
        },
      },
    },
  });

  const gate = result?.diagnostics?.decisionGate || {};
  const coverage = gate?.citationCoverage || {};
  const required = [
    "fabricationSignal",
    "fabricationSignalReason",
    "fabricationRatio",
    "unknownRatio",
    "unverifiableRatio",
    "verifiedRatio",
  ];
  required.forEach((field) => {
    assert.ok(Object.prototype.hasOwnProperty.call(coverage, field), `missing decisionGate.citationCoverage.${field}`);
  });
  assert.equal(result?.diagnostics?.decisionGateEmissionCheck, true);

  const debugState = {
    ...state,
    decisionGateResult: gate,
    quality: {
      ...(state.quality || {}),
      reasonCodes: result?.reasonCodes || [],
    },
    ui: {
      ...(state.ui || {}),
      status: "error",
    },
    diagnostics: {
      ...(state.diagnostics || {}),
      stages: [{
        stage: "stage_15_finalize",
        diagnostics: {
          decisionGate: gate,
        },
      }],
    },
  };
  const bundle = buildDebugBundle(debugState, { status: "error" });
  const emitted = bundle?.stages?.[0]?.diagnostics?.decisionGate?.citationCoverage || {};
  required.forEach((field) => {
    assert.ok(Object.prototype.hasOwnProperty.call(emitted, field), `missing debugBundle.stages[].diagnostics.decisionGate.citationCoverage.${field}`);
  });
});

