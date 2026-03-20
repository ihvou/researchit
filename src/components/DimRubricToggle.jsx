import { useState } from "react";

export default function DimRubricToggle({ dim }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8, lineHeight: 1.5 }}>
      {dim.brief}{" "}
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", color: "#6d28d9", fontSize: 11, padding: 0, cursor: "pointer" }}>
        {open ? "\u25b2 hide rubric" : "\u25bc scoring rubric"}
      </button>
      {open && (
        <pre style={{
          marginTop: 8, padding: "10px 12px",
          background: "#08090f", border: "1px solid #1e2130", borderRadius: 6,
          fontSize: 11, color: "#6b7280", whiteSpace: "pre-wrap", lineHeight: 1.65, fontFamily: "inherit",
        }}>
          {dim.fullDef}
        </pre>
      )}
    </div>
  );
}
