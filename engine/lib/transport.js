function ensureFunction(callFn) {
  if (typeof callFn !== "function") {
    throw new Error("createTransport requires a callFn(role, payload) function");
  }
}

function normalizeResult(data, includeMeta = false) {
  if (data?.error) {
    throw new Error(data.error);
  }
  if (includeMeta) return data;
  return data?.text;
}

export function createTransport(callFn) {
  ensureFunction(callFn);

  return {
    async callAnalyst(messages, systemPrompt, maxTokens = 5000, options = {}) {
      const payload = {
        messages,
        systemPrompt,
        maxTokens,
        liveSearch: !!options.liveSearch,
        provider: typeof options.provider === "string" ? options.provider : undefined,
        model: typeof options.model === "string" ? options.model : undefined,
        webSearchModel: typeof options.webSearchModel === "string" ? options.webSearchModel : undefined,
        baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
      };
      const data = await callFn("analyst", payload);
      return normalizeResult(data, !!options.includeMeta);
    },

    async callCritic(messages, systemPrompt, maxTokens = 5000, options = {}) {
      const payload = {
        messages,
        systemPrompt,
        maxTokens,
        liveSearch: !!options.liveSearch,
        provider: typeof options.provider === "string" ? options.provider : undefined,
        model: typeof options.model === "string" ? options.model : undefined,
        webSearchModel: typeof options.webSearchModel === "string" ? options.webSearchModel : undefined,
        baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
      };
      const data = await callFn("critic", payload);
      return normalizeResult(data, !!options.includeMeta);
    },

    async fetchSource(url) {
      const data = await callFn("fetch-source", { url });
      if (data?.error) throw new Error(data.error);
      return data;
    },
  };
}
