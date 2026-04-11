import { consumeMagicLinkToken, createSessionToken, setSessionCookie } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = String(req.body?.token || "").trim();
  if (!token) {
    return res.status(400).json({ error: "Missing token" });
  }

  try {
    const resolved = await consumeMagicLinkToken(token);
    if (!resolved?.user) {
      return res.status(400).json({ error: "Invalid or expired magic link" });
    }

    const sessionToken = createSessionToken(resolved.user);
    setSessionCookie(req, res, sessionToken);

    return res.status(200).json({
      ok: true,
      user: {
        id: resolved.user.id,
        email: resolved.user.email,
      },
      nextPath: resolved.nextPath || "/",
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed to verify token" });
  }
}
