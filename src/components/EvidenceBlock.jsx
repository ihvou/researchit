import { useState } from "react";
import SourcesList from "./SourcesList";

export default function EvidenceBlock({ brief, full, sources, risks }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <p style={{ fontSize: 12, color: "#cbd5e1", margin: "0 0 6px", lineHeight: 1.7 }}>{brief}</p>
      {(full || sources?.length || risks) && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{ background: "none", border: "none", color: "#7c3aed", fontSize: 11, padding: 0, cursor: "pointer", marginBottom: expanded ? 10 : 0 }}>
            {expanded ? "\u25b2 Collapse full analysis" : "\u25bc Full analysis & sources"}
          </button>
          {expanded && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #1f2937" }}>
              {full && (
                <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.75, margin: "0 0 10px" }}>{full}</p>
              )}
              <SourcesList sources={sources} />
              {risks && (
                <div style={{
                  marginTop: 10, padding: "8px 12px",
                  background: "#180d00", borderLeft: "3px solid #f97316",
                  borderRadius: "0 6px 6px 0",
                }}>
                  <div style={{ fontSize: 10, color: "#fb923c", fontWeight: 700, marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.8 }}>
                    Key Risks & Caveats
                  </div>
                  <p style={{ fontSize: 11, color: "#fdba74", margin: 0, lineHeight: 1.6 }}>{risks}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
