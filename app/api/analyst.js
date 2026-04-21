import crypto from "node:crypto";
import {
  resolveRoleProviderCandidates,
  resolveStrictRoute,
  missingApiKeyError,
} from "./providerConfig.js";
import { callProviderModel } from "./providerCalls.js";
import { getSessionUser } from "./_lib/auth.js";
import {
  appendRawProviderCall,
  isRawCallCacheEnabledForStage,
} from "./_lib/store.js";

const ANALYST_DEFAULT_MODEL = "gpt-5.4";
const ROUTE_MISMATCH_REASON_CODE = "route_mismatch_preflight";

function clean(value) {
  return String(value || "").trim();
}

function hashRequestPayload(payload = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload || {}))
    .digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    messages,
    systemPrompt,
    maxTokens = 5000,
    liveSearch = false,
    searchMaxUses,
    deepResearch = false,
    provider,
    model,
    webSearchModel,
    baseUrl, // per-request model routing only (not API key BYOK)
    stageId,
    runId,
    chunkId,
    callIndex,
    promptVersion,
  } = req.body || {};

  if (!messages || !systemPrompt) {
    return res.status(400).json({ error: "Missing messages or systemPrompt" });
  }

  const strictRouteRequested = clean(provider) && clean(model);
  const resolved = strictRouteRequested
    ? resolveStrictRoute({
      role: "analyst",
      provider,
      model,
      webSearchModel,
      baseUrl,
    })
    : (resolveRoleProviderCandidates({
      role: "analyst",
      requestedProvider: provider,
      requestedModel: model,
      requestedWebSearchModel: webSearchModel,
      requestedBaseUrl: baseUrl,
      defaultModel: ANALYST_DEFAULT_MODEL,
      liveSearch,
    })?.[0] || null);

  if (!resolved?.apiKey) {
    if (strictRouteRequested) {
      const stageLabel = clean(stageId) || "unknown_stage";
      const declaredProvider = clean(provider).toLowerCase();
      const declaredModel = clean(model);
      return res.status(500).json({
        error: `route_mismatch_preflight: ${stageLabel} declared ${declaredProvider}/${declaredModel} but no API key found for ${declaredProvider}. Set ${declaredProvider.toUpperCase()}_API_KEY.`,
        reasonCode: ROUTE_MISMATCH_REASON_CODE,
      });
    }
    return res.status(500).json({ error: missingApiKeyError("analyst") });
  }

  try {
    const result = await callProviderModel({
      providerId: resolved.providerId,
      apiKey: resolved.apiKey,
      model: resolved.model,
      webSearchModel: resolved.webSearchModel,
      messages,
      systemPrompt,
      maxTokens,
      liveSearch,
      deepResearch,
      searchMaxUses,
      baseUrl: resolved.baseUrl,
      stageId,
    });
    const { rawResponse, ...safeResult } = result || {};
    const authUser = await getSessionUser(req).catch(() => null);
    let rawResponseKey = "";
    if (
      authUser?.id
      && isRawCallCacheEnabledForStage(stageId)
      && clean(runId)
      && rawResponse
      && typeof rawResponse === "object"
    ) {
      try {
        const rawStore = await appendRawProviderCall(authUser.id, clean(runId), clean(stageId), {
          chunkId: clean(chunkId) || "default",
          provider: clean(result?.meta?.providerId || resolved.providerId),
          model: clean(result?.meta?.model || resolved.model),
          requestHash: hashRequestPayload({
            provider: clean(resolved.providerId),
            model: clean(resolved.model),
            systemPrompt: clean(systemPrompt),
            messages: Array.isArray(messages) ? messages : [],
            maxTokens: Number(maxTokens) || 0,
            liveSearch: !!liveSearch,
            searchMaxUses: Number.isFinite(Number(searchMaxUses)) ? Math.max(1, Math.floor(Number(searchMaxUses))) : 0,
            deepResearch: !!deepResearch,
            callIndex: Number.isFinite(Number(callIndex)) ? Number(callIndex) : -1,
          }),
          promptVersion: clean(promptVersion),
          rawResponse,
        });
        rawResponseKey = clean(rawStore?.rawResponseKey);
      } catch (_) {
        rawResponseKey = "";
      }
    }
    return res.status(200).json({
      ...safeResult,
      meta: {
        ...(safeResult?.meta || {}),
        providerId: safeResult?.meta?.providerId || resolved.providerId,
        providerFallbackUsed: false,
        providerAttemptCount: 1,
        providerRoutePinned: true,
        ...(rawResponseKey ? { rawResponseKey } : {}),
      },
    });
  } catch (err) {
    const detail = err?.message || "Unknown provider error";
    const abortReason = err?.abortReason && typeof err.abortReason === "object"
      ? err.abortReason
      : undefined;
    return res.status(500).json({
      error: `Pinned analyst provider route failed (${resolved.providerId}): ${detail}`,
      ...(abortReason ? { abortReason } : {}),
    });
  }
}
