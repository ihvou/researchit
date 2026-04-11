import { buildOrigin, issueMagicLink, sendMagicLinkEmail } from "../_lib/auth.js";

function allowDevLinks() {
  const explicit = String(process.env.RESEARCHIT_AUTH_ALLOW_DEV_LINK || "").trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  if (explicit === "1" || explicit === "true" || explicit === "on") return true;
  return String(process.env.NODE_ENV || "").toLowerCase() !== "production";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const nextPath = String(req.body?.nextPath || "/").trim() || "/";

  try {
    const issued = await issueMagicLink(email, {
      nextPath,
      origin: buildOrigin(req),
    });

    let delivery = "email";
    let reason = "";
    let devMagicLink = "";
    try {
      const emailResult = await sendMagicLinkEmail({ to: issued.user.email, magicLink: issued.magicLink });
      delivery = emailResult?.delivery || "email";
      reason = String(emailResult?.reason || "");
      if (delivery === "dev" && allowDevLinks()) {
        devMagicLink = issued.magicLink;
      }
    } catch (err) {
      if (allowDevLinks()) {
        delivery = "dev";
        reason = err?.message || "Email delivery failed";
        devMagicLink = issued.magicLink;
      } else {
        throw err;
      }
    }

    return res.status(200).json({
      ok: true,
      delivery,
      reason,
      ttlSeconds: issued.ttlSeconds,
      storageMode: issued.storageMode,
      devMagicLink,
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || "Failed to issue magic link" });
  }
}
