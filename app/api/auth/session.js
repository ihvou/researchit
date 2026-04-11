import { clearSessionCookie, getSessionUser } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const user = await getSessionUser(req);
    if (!user) {
      clearSessionCookie(req, res);
      return res.status(200).json({ authenticated: false, user: null });
    }
    return res.status(200).json({
      authenticated: true,
      user,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed to resolve session" });
  }
}
