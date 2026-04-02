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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = String(req.body?.url || "").trim();
  if (!isValidHttpUrl(url)) {
    return res.status(400).json({ error: "Invalid URL. Only http/https are allowed." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Researchit/1.0 (+https://github.com/ihvou/researchit)",
        Accept: "text/html, text/plain;q=0.9, application/json;q=0.7, */*;q=0.5",
      },
    });

    if (!response.ok) {
      return res.status(400).json({ error: `Source fetch failed (${response.status})` });
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
      return res.status(400).json({ error: "Source content is empty or unreadable." });
    }

    return res.status(200).json({
      url,
      title: title || "",
      text: text.slice(0, 12000),
      contentType,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed to fetch source." });
  } finally {
    clearTimeout(timeout);
  }
}
