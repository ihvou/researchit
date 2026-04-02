function cleanText(value) {
  return String(value || "").trim();
}

function shortSentence(text, fallback = "") {
  const raw = cleanText(text);
  if (!raw) return fallback;
  const idx = raw.search(/[.!?]\s/);
  if (idx === -1) return raw;
  return raw.slice(0, idx + 1).trim();
}

function normalizeSource(source) {
  if (!source || typeof source !== "object") return null;
  const name = cleanText(source.name);
  const quote = cleanText(source.quote);
  const url = cleanText(source.url);
  if (!name && !quote && !url) return null;
  return { name, quote, url };
}

function normalizeSources(sources = []) {
  if (!Array.isArray(sources)) return [];
  return sources
    .map(normalizeSource)
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeArgumentItem(raw, group, index, fallbackSources = []) {
  const claim = cleanText(raw?.claim);
  if (!claim) return null;
  const detail = cleanText(raw?.detail);
  const id = cleanText(raw?.id) || `${group}-${index + 1}`;
  const status = cleanText(raw?.status).toLowerCase() === "discarded" ? "discarded" : "active";
  const discardedBy = cleanText(raw?.discardedBy);
  const discardReason = cleanText(raw?.discardReason);
  const discardedAt = cleanText(raw?.discardedAt);
  const sources = normalizeSources(raw?.sources?.length ? raw.sources : fallbackSources);
  return {
    id,
    group,
    claim,
    detail,
    sources,
    status,
    discardedBy,
    discardReason,
    discardedAt,
  };
}

function cloneArgs(args = []) {
  return (args || []).map((a) => ({
    ...a,
    sources: Array.isArray(a.sources) ? a.sources.map((s) => ({ ...s })) : [],
  }));
}

export function ensureDimensionArgumentShape(dim = {}, dimId = "") {
  const argsObj = dim?.arguments && typeof dim.arguments === "object" ? dim.arguments : {};
  const baseSources = normalizeSources(dim?.sources || []);

  const supportingRaw = Array.isArray(argsObj.supporting) ? argsObj.supporting : [];
  const limitingRaw = Array.isArray(argsObj.limiting) ? argsObj.limiting : [];

  let supporting = supportingRaw
    .map((item, idx) => normalizeArgumentItem(item, "supporting", idx, baseSources))
    .filter(Boolean);
  let limiting = limitingRaw
    .map((item, idx) => normalizeArgumentItem(item, "limiting", idx, baseSources))
    .filter(Boolean);

  if (!supporting.length && cleanText(dim?.brief)) {
    supporting = [{
      id: `${dimId || "dim"}-supporting-1`,
      group: "supporting",
      claim: shortSentence(dim.brief, "Supporting signal exists."),
      detail: shortSentence(dim.full || dim.brief, ""),
      sources: baseSources,
      status: "active",
      discardedBy: "",
      discardReason: "",
      discardedAt: "",
    }];
  }

  if (!limiting.length && cleanText(dim?.risks)) {
    limiting = [{
      id: `${dimId || "dim"}-limiting-1`,
      group: "limiting",
      claim: shortSentence(dim.risks, "Key limiting factors remain."),
      detail: cleanText(dim.risks),
      sources: [],
      status: "active",
      discardedBy: "",
      discardReason: "",
      discardedAt: "",
    }];
  }

  return { supporting, limiting };
}

export function findArgument(shape, group, id) {
  const list = group === "limiting" ? shape?.limiting : shape?.supporting;
  return (list || []).find((a) => a.id === id) || null;
}

function applyDiscard(target, by, reason) {
  if (!target) return;
  target.status = "discarded";
  target.discardedBy = by || target.discardedBy || "pm";
  target.discardReason = reason || target.discardReason || "";
  target.discardedAt = target.discardedAt || new Date().toISOString();
}

export function applyThreadArgumentUpdates(baseShape, thread = []) {
  const shape = {
    supporting: cloneArgs(baseShape?.supporting || []),
    limiting: cloneArgs(baseShape?.limiting || []),
  };

  for (const msg of thread || []) {
    if (!msg || typeof msg !== "object") continue;

    const pmAction = msg.role === "pm" ? msg.argumentAction : null;
    if (pmAction?.action === "discard" && pmAction.id) {
      const target = findArgument(shape, pmAction.group, pmAction.id);
      applyDiscard(target, "pm", pmAction.reason || "Discarded by PM.");
      continue;
    }

    const analystUpdate = msg.role === "analyst" ? msg.argumentUpdate : null;
    if (!analystUpdate || !analystUpdate.id) continue;
    const target = findArgument(shape, analystUpdate.group, analystUpdate.id);
    if (!target) continue;

    const action = cleanText(analystUpdate.action).toLowerCase();
    if (action === "discard") {
      applyDiscard(target, "analyst", analystUpdate.reason || "Discarded after challenge.");
      continue;
    }

    if (action === "modify") {
      const claim = cleanText(analystUpdate.updatedClaim);
      const detail = cleanText(analystUpdate.updatedDetail);
      if (claim) target.claim = claim;
      if (detail) target.detail = detail;
      if (Array.isArray(analystUpdate.sources)) {
        target.sources = normalizeSources(analystUpdate.sources);
      }
      if (target.status === "discarded") {
        target.status = "active";
        target.discardReason = "";
        target.discardedBy = "";
        target.discardedAt = "";
      }
    }
  }

  return shape;
}

