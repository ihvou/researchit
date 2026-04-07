export const EXPORT_SCHEMA_VERSION = 1;

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMode(value) {
  return String(value || "").trim().toLowerCase() === "matrix" ? "matrix" : "scorecard";
}

function getUseCaseMode(uc) {
  return normalizeMode(uc?.outputMode || (uc?.matrix ? "matrix" : "scorecard"));
}

function dimensionConfigSnapshot(items = []) {
  return (items || []).map((item) => {
    const weight = Number(item?.weight);
    return {
      id: item?.id,
      label: item?.label,
      weight: Number.isFinite(weight) ? weight : null,
      enabled: item?.enabled !== false,
    };
  });
}

function isCompletedUseCase(uc) {
  return uc?.status === "complete" && isPlainObject(uc);
}

function validateUseCaseShape(uc) {
  if (!isPlainObject(uc)) throw new Error("Use case entry is not an object.");
  if (typeof uc.id !== "string" || !uc.id.trim()) throw new Error("Use case is missing a valid id.");
  if (typeof uc.rawInput !== "string") throw new Error(`Use case ${uc.id} is missing rawInput.`);
  if (uc.status !== "complete") throw new Error(`Use case ${uc.id} is not completed.`);

  const mode = getUseCaseMode(uc);
  if (mode === "matrix") {
    if (!isPlainObject(uc.matrix)) throw new Error(`Use case ${uc.id} is missing matrix results.`);
    if (!Array.isArray(uc.matrix.subjects)) throw new Error(`Use case ${uc.id} has invalid matrix subjects.`);
    if (!Array.isArray(uc.matrix.attributes)) throw new Error(`Use case ${uc.id} has invalid matrix attributes.`);
    if (!Array.isArray(uc.matrix.cells)) throw new Error(`Use case ${uc.id} has invalid matrix cells.`);
    return;
  }

  if (!isPlainObject(uc.dimScores)) throw new Error(`Use case ${uc.id} is missing dimScores.`);
  if (!isPlainObject(uc.finalScores)) throw new Error(`Use case ${uc.id} is missing finalScores.`);
  if (!Array.isArray(uc.debate)) throw new Error(`Use case ${uc.id} has invalid debate history.`);
  if (uc.followUps != null && !isPlainObject(uc.followUps)) {
    throw new Error(`Use case ${uc.id} has invalid follow-up threads.`);
  }
}

function compareConfigMode(envelopeMode, currentMode) {
  const a = normalizeMode(envelopeMode);
  const b = normalizeMode(currentMode);
  return a === b;
}

function sameFiniteNumber(a, b) {
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isFinite(an) && !Number.isFinite(bn)) return true;
  return an === bn;
}

function compareDimensionConfigs(importedConfig = [], currentItems = [], outputMode = "scorecard") {
  const current = dimensionConfigSnapshot(currentItems);
  if (!Array.isArray(importedConfig) || importedConfig.length !== current.length) return false;
  for (let i = 0; i < importedConfig.length; i += 1) {
    const a = importedConfig[i];
    const b = current[i];
    if (!a || !b) return false;
    if (a.id !== b.id) return false;
    if (normalizeMode(outputMode) === "scorecard" && !sameFiniteNumber(a.weight, b.weight)) return false;
    if (!!a.enabled !== !!b.enabled) return false;
  }
  return true;
}

function parseEnvelope(text, appVersion = "") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error("File is not valid JSON.");
  }
  if (!isPlainObject(parsed)) throw new Error("Top-level JSON must be an object.");
  if (typeof parsed.format !== "string") throw new Error("Missing export format marker.");
  if (!Number.isFinite(Number(parsed.schemaVersion))) throw new Error("Missing or invalid schemaVersion.");
  const schemaVersion = Number(parsed.schemaVersion);
  if (schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new Error(`File was produced by a newer schema version (${schemaVersion}).`);
  }
  if (typeof parsed.appVersion === "string" && parsed.appVersion.trim() && appVersion) {
    const fileMajor = Number(String(parsed.appVersion).split(".")[0]) || 0;
    const currentMajor = Number(String(appVersion).split(".")[0]) || 0;
    if (fileMajor > currentMajor && currentMajor > 0) {
      throw new Error(`File was produced by a newer app version (${parsed.appVersion}).`);
    }
  }
  if (parsed.format !== "uc-single" && parsed.format !== "uc-portfolio") {
    throw new Error(`Unsupported export format: ${parsed.format}`);
  }
  return parsed;
}

function extractImportedUseCases(envelope) {
  if (envelope.format === "uc-single") {
    if (!isPlainObject(envelope.useCase)) throw new Error("Single-use-case file is missing useCase payload.");
    validateUseCaseShape(envelope.useCase);
    return [deepClone(envelope.useCase)];
  }
  if (!Array.isArray(envelope.useCases)) throw new Error("Portfolio file is missing useCases array.");
  envelope.useCases.forEach(validateUseCaseShape);
  return deepClone(envelope.useCases);
}

export function buildSingleUseCaseJsonPayload(uc, dims, options = {}) {
  if (!isCompletedUseCase(uc)) {
    throw new Error("Only completed use cases can be exported as JSON.");
  }
  validateUseCaseShape(uc);
  return {
    format: "uc-single",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    appVersion: options.appVersion || "",
    exportedAt: new Date().toISOString(),
    outputMode: getUseCaseMode(uc),
    dimensionConfig: dimensionConfigSnapshot(dims),
    useCase: deepClone(uc),
  };
}

export function buildPortfolioJsonPayload(useCases, dims, options = {}) {
  const completed = (useCases || []).filter(isCompletedUseCase);
  completed.forEach(validateUseCaseShape);
  return {
    format: "uc-portfolio",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    appVersion: options.appVersion || "",
    exportedAt: new Date().toISOString(),
    outputMode: normalizeMode(options.outputMode || ""),
    dimensionConfig: dimensionConfigSnapshot(dims),
    useCases: deepClone(completed),
  };
}

export function importUseCasesFromJsonText(text, currentItems, existingIds = [], options = {}) {
  const envelope = parseEnvelope(text, options.appVersion || "");
  const importedUseCases = extractImportedUseCases(envelope);

  const seen = new Set(existingIds || []);
  for (const uc of importedUseCases) {
    if (seen.has(uc.id)) {
      throw new Error(`Duplicate use case id detected: ${uc.id}`);
    }
    seen.add(uc.id);
  }

  const currentMode = normalizeMode(options.outputMode || importedUseCases?.[0]?.outputMode || "");
  const modeCompatible = compareConfigMode(envelope.outputMode || importedUseCases?.[0]?.outputMode || "", currentMode);
  const configCompatible = modeCompatible && compareDimensionConfigs(envelope.dimensionConfig || [], currentItems, currentMode);
  let warning = "";
  if (!modeCompatible) {
    warning = "Imported file was produced with a different research mode. Verify compatibility before comparing results.";
  } else if (!configCompatible) {
    warning = currentMode === "matrix"
      ? "Imported matrix used different attribute configuration. Compare findings cautiously."
      : "Imported scores were calculated with different dimension weights - weighted totals have been recalculated using your current settings.";
  }

  return {
    useCases: importedUseCases,
    warning,
    envelopeMeta: {
      format: envelope.format,
      appVersion: envelope.appVersion || "",
      schemaVersion: Number(envelope.schemaVersion),
      exportedAt: envelope.exportedAt || "",
    },
  };
}
