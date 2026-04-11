import { useEffect, useState } from "react";
import Spinner from "./Spinner.jsx";

export default function AuthModal({
  open,
  onClose,
  onRequestLink,
  requesting = false,
  error = "",
  delivery = null,
  devMagicLink = "",
  defaultEmail = "",
}) {
  const [email, setEmail] = useState(defaultEmail || "");

  useEffect(() => {
    if (!open) return;
    setEmail(defaultEmail || "");
  }, [open, defaultEmail]);

  if (!open) return null;

  const isDisabled = requesting || !String(email || "").trim();

  return (
    <div className="setup-modal-backdrop" onClick={() => !requesting && onClose?.()}>
      <div className="setup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="setup-modal-header">
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ck-text)" }}>Sign in / Sign up</div>
          <button
            type="button"
            onClick={() => !requesting && onClose?.()}
            style={{
              border: "1px solid var(--ck-line)",
              background: "var(--ck-surface)",
              color: "var(--ck-text)",
              width: 28,
              height: 28,
              padding: 0,
              display: "grid",
              placeItems: "center",
              fontSize: 14,
              fontWeight: 700,
            }}>
            ×
          </button>
        </div>

        <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.5 }}>
          Enter your email to receive a magic link. No password is required.
        </div>

        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            Email
          </div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoFocus
            style={{
              width: "100%",
              background: "var(--ck-surface-soft)",
              border: "1px solid var(--ck-line)",
              borderRadius: 2,
              color: "var(--ck-text)",
              padding: "9px 11px",
              fontSize: 12,
              lineHeight: 1.4,
              outline: "none",
            }}
          />
        </div>

        {error ? (
          <div style={{ marginTop: 10, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "8px 10px", color: "var(--ck-text)", fontSize: 12 }}>
            {error}
          </div>
        ) : null}

        {delivery ? (
          <div style={{ marginTop: 10, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "8px 10px", color: "var(--ck-muted)", fontSize: 12, lineHeight: 1.5 }}>
            {delivery === "email"
              ? "Magic link sent. Open it from your inbox in this browser session."
              : "Email delivery is not configured. Use the temporary dev magic link below."}
            {devMagicLink ? (
              <div style={{ marginTop: 6 }}>
                <a href={devMagicLink} style={{ color: "var(--ck-accent)", wordBreak: "break-all" }}>Open magic link</a>
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={requesting}
            style={{
              border: "1px solid var(--ck-line)",
              background: "var(--ck-surface)",
              color: "var(--ck-text)",
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 700,
              opacity: requesting ? 0.6 : 1,
            }}>
            Close
          </button>
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => onRequestLink?.(email)}
            style={{
              border: "1px solid var(--ck-accent)",
              background: "var(--ck-accent)",
              color: "var(--ck-accent-ink)",
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: isDisabled ? 0.65 : 1,
            }}>
            {requesting ? <><Spinner size={10} color="var(--ck-accent-ink)" /> Sending...</> : "Send magic link"}
          </button>
        </div>
      </div>
    </div>
  );
}
