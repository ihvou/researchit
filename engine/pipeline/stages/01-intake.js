import { ensureRequiredRequestInputs } from "../contracts/run-state.js";

export const STAGE_ID = "stage_01_intake";
export const STAGE_TITLE = "Input Intake";

export async function runStage(context = {}) {
  const { state } = context;
  ensureRequiredRequestInputs(state);

  const autoDiscoverSubjects = state?.outputType === "matrix"
    && (!Array.isArray(state?.request?.matrix?.subjects) || !state.request.matrix.subjects.length);

  return {
    stageStatus: "ok",
    reasonCodes: [],
    statePatch: {
      discovery: {
        autoDiscoverSubjects,
        usedSubjectDiscovery: false,
        suggestedSubjects: [],
        suggestedAttributes: [],
        notes: "",
      },
      ui: {
        phase: STAGE_ID,
      },
    },
    diagnostics: {
      autoDiscoverSubjects,
      outputType: state?.outputType,
      evidenceMode: state?.mode,
    },
  };
}
