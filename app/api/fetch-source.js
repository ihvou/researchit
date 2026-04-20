function sanitizeText(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(html) {
  const withoutScripts = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const titleMatch = withoutScripts.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = sanitizeText(decodeEntities(titleMatch?.[1] || ""));

  const text = sanitizeText(
    decodeEntities(
      withoutScripts
        .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|section|article|br)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );

  return { title, text };
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function sourceFetchError(res, message, status = "fetch_failed") {
  return res.status(200).json({
    error: String(message || "Source fetch failed."),
    sourceFetchError: true,
    sourceFetchStatus: status,
    fetchedAt: new Date().toISOString(),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = String(req.body?.url || "").trim();
  const resolveOnly = req.body?.resolveOnly === true;
  if (!isValidHttpUrl(url)) {
    return sourceFetchError(res, "Invalid URL. Only http/https are allowed.", "invalid_url");
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutMs = 10000;
  const timeout = setTimeout(() => controller.abort({
    source: "provider_timeout",
    layer: "fetch_source",
    deadlineMs: timeoutMs,
    elapsedMs: Date.now() - startedAt,
  }), timeoutMs);

  try {
    const headers = {
      "User-Agent": "Researchit/1.0 (+https://github.com/ihvou/researchit)",
      Accept: "text/html, text/plain;q=0.9, application/json;q=0.7, */*;q=0.5",
    };
    let response;
    if (resolveOnly) {
      response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers,
      });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal,
          headers,
        });
      }
      return res.status(200).json({
        url,
        resolvedUrl: String(response?.url || url),
        responseStatus: Number(response?.status || 0),
        reachable: !!response?.ok,
        contentType: String(response?.headers?.get?.("content-type") || "").toLowerCase(),
        sourceFetchStatus: response?.ok ? "resolved" : String(response?.status || "fetch_failed"),
        fetchedAt: new Date().toISOString(),
      });
    }
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers,
    });

    const resolvedUrl = String(response.url || url);
    if (!response.ok) {
      return res.status(200).json({
        error: `Source fetch failed (${response.status})`,
        sourceFetchError: true,
        sourceFetchStatus: String(response.status),
        resolvedUrl,
        fetchedAt: new Date().toISOString(),
      });
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const raw = await response.text();
    const body = raw.slice(0, 240000);

    let title = "";
    let text = "";

    if (contentType.includes("text/html")) {
      const parsed = htmlToText(body);
      title = parsed.title;
      text = parsed.text;
    } else {
      text = sanitizeText(body);
    }

    if (!text) {
      return res.status(200).json({
        error: "Source content is empty or unreadable.",
        sourceFetchError: true,
        sourceFetchStatus: "empty_content",
        resolvedUrl,
        fetchedAt: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      url,
      resolvedUrl,
      title: title || "",
      text: text.slice(0, 12000),
      contentType,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const abortReason = err?.cause && typeof err.cause === "object"
      ? err.cause
      : (controller?.signal?.reason && typeof controller.signal.reason === "object" ? controller.signal.reason : null);
    return res.status(200).json({
      error: err?.message || "Failed to fetch source.",
      sourceFetchError: true,
      sourceFetchStatus: "fetch_exception",
      resolvedUrl: "",
      ...(abortReason ? { abortReason } : {}),
      fetchedAt: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timeout);
  }
}
