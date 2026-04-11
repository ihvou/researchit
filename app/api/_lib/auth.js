import crypto from "node:crypto";
import { consumeMagicToken, getOrCreateUserByEmail, getStorageMode, putMagicToken } from "./store.js";

const SESSION_COOKIE_NAME = "researchit_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAGIC_LINK_TTL_SECONDS = 60 * 15; // 15 minutes
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(input) {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64").toString("utf8");
}

function authSecret() {
  const configured = String(process.env.RESEARCHIT_AUTH_SECRET || process.env.SESSION_SECRET || "").trim();
  if (configured) return configured;
  const fallback = String(process.env.OPENAI_API_KEY || "").trim();
  if (fallback) return fallback;
  return "researchit-dev-auth-secret";
}

function signValue(value) {
  return crypto
    .createHmac("sha256", authSecret())
    .update(value)
    .digest("base64url");
}

function safePath(pathValue = "/") {
  const value = String(pathValue || "/").trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  return value;
}

export function isValidEmail(email) {
  return EMAIL_REGEX.test(String(email || "").trim().toLowerCase());
}

export function parseCookies(req) {
  const raw = String(req?.headers?.cookie || "");
  const out = {};
  raw.split(";").forEach((part) => {
    const [name, ...rest] = part.split("=");
    const key = String(name || "").trim();
    if (!key) return;
    out[key] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }
  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookieValue]);
    return;
  }
  res.setHeader("Set-Cookie", [current, cookieValue]);
}

export function buildOrigin(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (process.env.NODE_ENV === "development" ? "http" : "https");
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").trim();
  if (!host) return "http://localhost:5173";
  return `${proto}://${host}`;
}

export function createSessionToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    exp: nowSeconds() + SESSION_MAX_AGE_SECONDS,
  };
  const encoded = base64url(JSON.stringify(payload));
  const sig = signValue(encoded);
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token) {
  const raw = String(token || "").trim();
  if (!raw.includes(".")) return null;
  const [encoded, sig] = raw.split(".");
  if (!encoded || !sig) return null;
  const expected = signValue(encoded);
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(fromBase64url(encoded));
    if (!payload?.sub || !payload?.exp) return null;
    if (Number(payload.exp) <= nowSeconds()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

export function setSessionCookie(req, res, token) {
  const isSecure = String(req?.headers?.["x-forwarded-proto"] || "").toLowerCase().includes("https")
    || String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (isSecure) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

export function clearSessionCookie(req, res) {
  const isSecure = String(req?.headers?.["x-forwarded-proto"] || "").toLowerCase().includes("https")
    || String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isSecure) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

export async function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload?.sub || !payload?.email) return null;
  return {
    id: payload.sub,
    email: payload.email,
  };
}

export async function requireSessionUser(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    return { user: null, handled: res.status(401).json({ error: "Not authenticated" }) };
  }
  return { user, handled: null };
}

export async function issueMagicLink(email, options = {}) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    throw new Error("Please provide a valid email address.");
  }
  const user = await getOrCreateUserByEmail(normalizedEmail);
  const token = crypto.randomBytes(24).toString("hex");
  const nextPath = safePath(options?.nextPath || "/");
  await putMagicToken(token, {
    userId: user.id,
    email: user.email,
    nextPath,
  }, MAGIC_LINK_TTL_SECONDS);

  const origin = String(options?.origin || "").trim() || "http://localhost:5173";
  const magicLink = `${origin}/auth/callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(nextPath)}`;
  return {
    user,
    token,
    nextPath,
    magicLink,
    ttlSeconds: MAGIC_LINK_TTL_SECONDS,
    storageMode: getStorageMode(),
  };
}

export async function consumeMagicLinkToken(token) {
  const payload = await consumeMagicToken(token);
  if (!payload?.email) return null;
  const user = await getOrCreateUserByEmail(payload.email);
  return {
    user,
    nextPath: safePath(payload.nextPath || "/"),
  };
}

export async function sendMagicLinkEmail({ to, magicLink }) {
  const resendApiKey = String(process.env.RESEND_API_KEY || "").trim();
  const fromEmail = String(process.env.RESEARCHIT_AUTH_FROM_EMAIL || "").trim();
  if (!resendApiKey || !fromEmail) {
    return {
      delivery: "dev",
      reason: "RESEND_API_KEY or RESEARCHIT_AUTH_FROM_EMAIL is not configured",
    };
  }

  const payload = {
    from: fromEmail,
    to: [to],
    subject: "Sign in to Research it",
    text: `Use this magic link to sign in to Research it: ${magicLink}\n\nThis link expires in 15 minutes.`,
    html: `<p>Use this magic link to sign in to <strong>Research it</strong>:</p><p><a href="${magicLink}">${magicLink}</a></p><p>This link expires in 15 minutes.</p>`,
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Failed to send magic link email (${res.status})${detail ? `: ${detail.slice(0, 240)}` : ""}`);
  }

  return { delivery: "email" };
}
