import { callOpenAI } from "@researchit/engine";

const CRITIC_MODEL = "gpt-5.4";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { messages, systemPrompt, maxTokens = 5000, liveSearch = false } = req.body || {};
  if (!messages || !systemPrompt) {
    return res.status(400).json({ error: "Missing messages or systemPrompt" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  }

  try {
    const result = await callOpenAI({
      apiKey,
      model: CRITIC_MODEL,
      messages,
      systemPrompt,
      maxTokens,
      liveSearch,
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "OpenAI request failed" });
  }
}
