import { normalizeReasonCodes } from "../../pipeline/contracts/reason-codes.js";

export function buildDebugBundle(state = {}, extras = {}) {
  const diagnostics = state?.diagnostics && typeof state.diagnostics === "object"
    ? state.diagnostics
    : {};
  const run = diagnostics?.run && typeof diagnostics.run === "object"
    ? diagnostics.run
    : {};

  return {
    schemaVersion: 2,
    run: {
      ...run,
      finishedAt: new Date().toISOString(),
      status: state?.ui?.status || extras?.status || "unknown",
      reasonCodes: normalizeReasonCodes([
        ...(Array.isArray(diagnostics?.reasonCodes) ? diagnostics.reasonCodes : []),
        ...(Array.isArray(state?.quality?.reasonCodes) ? state.quality.reasonCodes : []),
      ]),
    },
    routing: Array.isArray(diagnostics?.routing) ? diagnostics.routing : [],
    stages: Array.isArray(diagnostics?.stages) ? diagnostics.stages : [],
    io: Array.isArray(diagnostics?.io) ? diagnostics.io : [],
    quality: {
      ...(diagnostics?.quality && typeof diagnostics.quality === "object" ? diagnostics.quality : {}),
      stateQuality: state?.quality || null,
      decisionGate: state?.decisionGateResult || null,
    },
    cost: diagnostics?.cost || {},
    cacheDiagnostics: diagnostics?.cacheDiagnostics || {},
    progress: Array.isArray(diagnostics?.progress) ? diagnostics.progress : [],
    outputPreview: {
      outputMode: state?.outputType || null,
      status: state?.ui?.status || null,
      phase: state?.ui?.phase || null,
    },
    error: extras?.error
      ? {
        message: String(extras.error?.message || extras.error),
        stack: String(extras.error?.stack || ""),
      }
      : null,
  };
}
