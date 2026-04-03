import { useState } from "react";
import SourcesList from "./SourcesList";

function renderTextWithUrlAnchors(text) {
  if (!text) return null;
  const parts = [];
  const urlRegex = /https?:\/\/[^\s<>"']+/g;
  let lastIndex = 0;
  let sourceIdx = 1;

  let match = urlRegex.exec(text);
  while (match) {
    const raw = match[0];
    const start = match.index;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }

    const cleanUrl = raw.replace(/[),.;!?]+$/g, "");
    const trailing = raw.slice(cleanUrl.length);
    parts.push(
      <a
        key={`${start}-${sourceIdx}`}
        href={cleanUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--ck-text)", textDecoration: "none", fontWeight: 600 }}>
        Source {sourceIdx}
      </a>
    );
    if (trailing) parts.push(trailing);

    sourceIdx += 1;
    lastIndex = start + raw.length;
    match = urlRegex.exec(text);
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export default function EvidenceBlock({ brief, full, sources, risks }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <p style={{ fontSize: 12, color: "var(--ck-text)", margin: "0 0 6px", lineHeight: 1.7 }}>{brief}</p>
      {(full || sources?.length || risks) && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{ background: "none", border: "none", color: "var(--ck-text)", fontSize: 11, fontWeight: 600, padding: 0, cursor: "pointer", marginBottom: expanded ? 10 : 0 }}>
            {expanded ? "^ Collapse full analysis" : "v Full analysis & sources"}
          </button>
          {expanded && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--ck-line)" }}>
              {full && (
                <p style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.75, margin: "0 0 10px", whiteSpace: "pre-wrap" }}>
                  {renderTextWithUrlAnchors(full)}
                </p>
              )}
              <SourcesList sources={sources} />
              {risks && (
                <div style={{
                  marginTop: 10, padding: "8px 12px",
                  background: "var(--ck-risk-bg)",
                  border: "1px solid var(--ck-risk-line)",
                  borderRadius: 2,
                }}>
                  <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.8 }}>
                    Key Risks & Caveats
                  </div>
                  <p style={{ fontSize: 11, color: "var(--ck-muted)", margin: 0, lineHeight: 1.6 }}>{risks}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
