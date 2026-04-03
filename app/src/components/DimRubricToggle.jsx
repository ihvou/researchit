import { useState } from "react";

export default function DimRubricToggle({ dim }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ fontSize: 11, color: "var(--ck-muted)", marginBottom: 8, lineHeight: 1.5 }}>
      {dim.brief}{" "}
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", color: "var(--ck-text)", fontSize: 11, padding: 0, cursor: "pointer", fontWeight: 600 }}>
        {open ? "^ hide rubric" : "v scoring rubric"}
      </button>
      {open && (
        <pre style={{
          marginTop: 8, padding: "10px 12px",
          background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2,
          fontSize: 11, color: "var(--ck-muted)", whiteSpace: "pre-wrap", lineHeight: 1.65, fontFamily: "inherit",
        }}>
          {dim.fullDef}
        </pre>
      )}
    </div>
  );
}
