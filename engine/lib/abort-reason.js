function clean(value) {
  return String(value || "").trim();
}

export function normalizeAbortReason(value, fallbackSource = "unknown") {
  if (value && typeof value === "object") {
    const source = clean(value?.source) || fallbackSource;
    return {
      source,
      layer: clean(value?.layer) || undefined,
      deadlineMs: Number.isFinite(Number(value?.deadlineMs)) ? Number(value.deadlineMs) : undefined,
      elapsedMs: Number.isFinite(Number(value?.elapsedMs)) ? Number(value.elapsedMs) : undefined,
      status: Number.isFinite(Number(value?.status)) ? Number(value.status) : undefined,
      message: clean(value?.message) || undefined,
    };
  }
  return { source: clean(fallbackSource) || "unknown" };
}

export function attachAbortReason(error, reason, fallbackSource = "unknown") {
  if (!(error instanceof Error)) return error;
  const normalized = normalizeAbortReason(reason, fallbackSource);
  error.abortReason = normalized;
  if (!clean(error?.name)) error.name = "AbortError";
  return error;
}

export function abortControllerWithReason(timeoutMs, reasonBase = {}) {
  const controller = new AbortController();
  const deadlineMs = Number(timeoutMs);
  const startedAt = Date.now();
  let timer = null;
  if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
    timer = setTimeout(() => {
      const reason = normalizeAbortReason({
        ...reasonBase,
        deadlineMs,
        elapsedMs: Date.now() - startedAt,
      });
      try {
        controller.abort(reason);
      } catch (_) {
        // noop
      }
    }, deadlineMs);
  }
  return {
    controller,
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    startedAt,
    deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : undefined,
  };
}

