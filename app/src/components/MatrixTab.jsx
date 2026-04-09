import { useMemo, useState } from "react";
import ConfidenceBadge from "./ConfidenceBadge";

function cleanText(value) {
  return String(value || "").trim();
}

function getCellMap(cells = []) {
  const map = new Map();
  (cells || []).forEach((cell) => {
    map.set(`${cell.subjectId}::${cell.attributeId}`, cell);
  });
  return map;
}

function matrixCell(cell) {
  if (!cell) {
    return (
      <div style={{ fontSize: 11, color: "var(--ck-muted)" }}>
        No evidence captured.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ fontSize: 11, color: "var(--ck-text)", lineHeight: 1.45 }}>
        {cell.value || "No evidence captured."}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <ConfidenceBadge level={cell.confidence} reason={cell.confidenceReason} compact={true} />
        {cell.sources?.length ? (
          <span style={{ fontSize: 10, color: "var(--ck-muted)" }}>
            {cell.sources.length} source{cell.sources.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span style={{ fontSize: 10, color: "var(--ck-muted)" }}>
            no sources
          </span>
        )}
      </div>
      {cell.contested && cell.criticNote ? (
        <div style={{ fontSize: 10, color: "var(--ck-muted)", borderTop: "1px solid var(--ck-line)", paddingTop: 4 }}>
          Critic: {cell.criticNote}
        </div>
      ) : null}
    </div>
  );
}

export default function MatrixTab({ uc }) {
  const matrix = uc?.matrix || {};
  const subjects = Array.isArray(matrix?.subjects) ? matrix.subjects : [];
  const attributes = Array.isArray(matrix?.attributes) ? matrix.attributes : [];
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const subjectSummaries = Array.isArray(matrix?.subjectSummaries) ? matrix.subjectSummaries : [];
  const coverage = matrix?.coverage || {};
  const initialLayout = matrix?.layout === "subjects-as-columns"
    ? "subjects-as-columns"
    : matrix?.layout === "subjects-as-rows"
      ? "subjects-as-rows"
      : (subjects.length <= 4 ? "subjects-as-columns" : "subjects-as-rows");
  const [layout, setLayout] = useState(initialLayout);

  const cellMap = useMemo(() => getCellMap(cells), [cells]);
  const summaryMap = useMemo(() => {
    const map = new Map();
    subjectSummaries.forEach((entry) => {
      map.set(entry.subjectId, cleanText(entry.summary));
    });
    return map;
  }, [subjectSummaries]);

  if (!subjects.length || !attributes.length) {
    return (
      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "12px 14px" }}>
        <div style={{ fontSize: 12, color: "var(--ck-muted)" }}>
          Matrix results are not available yet.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            Comparison Matrix
          </div>
          <div style={{ display: "inline-flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => setLayout("subjects-as-rows")}
              style={{
                border: "1px solid var(--ck-line)",
                background: layout === "subjects-as-rows" ? "var(--ck-surface-soft)" : "var(--ck-surface)",
                color: "var(--ck-text)",
                fontSize: 11,
                fontWeight: 700,
                padding: "4px 8px",
              }}>
              Subjects as rows
            </button>
            <button
              type="button"
              onClick={() => setLayout("subjects-as-columns")}
              style={{
                border: "1px solid var(--ck-line)",
                background: layout === "subjects-as-columns" ? "var(--ck-surface-soft)" : "var(--ck-surface)",
                color: "var(--ck-text)",
                fontSize: 11,
                fontWeight: 700,
                padding: "4px 8px",
              }}>
              Subjects as columns
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.45 }}>
          {subjects.length} subject{subjects.length === 1 ? "" : "s"} × {attributes.length} attribute{attributes.length === 1 ? "" : "s"} | {coverage.totalCells || (subjects.length * attributes.length)} cells
          <span style={{ marginLeft: 8 }}>Low confidence: {coverage.lowConfidenceCells || 0}</span>
          <span style={{ marginLeft: 8 }}>Critic flags: {coverage.contestedCells || 0}</span>
        </div>
        {matrix.crossMatrixSummary ? (
          <div style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.5 }}>
            {matrix.crossMatrixSummary}
          </div>
        ) : null}
      </div>

      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, overflow: "auto" }}>
        {layout === "subjects-as-rows" ? (
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid var(--ck-line)", borderRight: "1px solid var(--ck-line)", padding: "8px 10px", background: "var(--ck-surface-soft)", fontSize: 11, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>
                  Subject
                </th>
                {attributes.map((attr) => (
                  <th key={attr.id} style={{ textAlign: "left", borderBottom: "1px solid var(--ck-line)", borderRight: "1px solid var(--ck-line)", padding: "8px 10px", background: "var(--ck-surface-soft)", fontSize: 11, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, minWidth: 220 }}>
                    <div>{attr.label}</div>
                    {attr.brief ? <div style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500, marginTop: 4 }}>{attr.brief}</div> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subjects.map((subject) => (
                <tr key={subject.id}>
                  <td style={{ borderBottom: "1px solid var(--ck-line)", borderRight: "1px solid var(--ck-line)", padding: "8px 10px", verticalAlign: "top", minWidth: 180 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ck-text)" }}>{subject.label}</div>
                    {summaryMap.get(subject.id) ? (
                      <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45, marginTop: 4 }}>
                        {summaryMap.get(subject.id)}
                      </div>
                    ) : null}
                  </td>
                  {attributes.map((attr) => (
                    <td key={`${subject.id}-${attr.id}`} style={{ borderBottom: "1px solid var(--ck-line)", borderRight: "1px solid var(--ck-line)", padding: "8px 10px", verticalAlign: "top", minWidth: 220 }}>
                      {matrixCell(cellMap.get(`${subject.id}::${attr.id}`))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid var(--ck-line)", borderRight: "1px solid var(--ck-line)", padding: "8px 10px", background: "var(--ck-surface-soft)", fontSize: 11, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>
                  Attribute
                </th>
                {subjects.map((subject) => (
                  <th key={subject.id} style={{ textAlign: "left", borderBottom: "1px solid var(--ck-line)", borderRight: "1px solid var(--ck-line)", padding: "8px 10px", background: "var(--ck-surface-soft)", fontSize: 11, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, minWidth: 220 }}>
                    {subject.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {attributes.map((attr) => (
                <tr key={attr.id}>
                  <td style={{ borderBottom: "1px solid var(--ck-line)", borderRight: "1px solid var(--ck-line)", padding: "8px 10px", verticalAlign: "top", minWidth: 180 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ck-text)" }}>{attr.label}</div>
                    {attr.brief ? <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45, marginTop: 4 }}>{attr.brief}</div> : null}
                  </td>
                  {subjects.map((subject) => (
                    <td key={`${attr.id}-${subject.id}`} style={{ borderBottom: "1px solid var(--ck-line)", borderRight: "1px solid var(--ck-line)", padding: "8px 10px", verticalAlign: "top", minWidth: 220 }}>
                      {matrixCell(cellMap.get(`${subject.id}::${attr.id}`))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {matrix.discovery && (matrix.discovery.suggestedSubjects?.length || matrix.discovery.suggestedAttributes?.length || matrix.discovery.notes) ? (
        <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            Related Discovery
          </div>
          {matrix.discovery.suggestedSubjects?.length ? (
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 11, color: "var(--ck-muted)", fontWeight: 700 }}>Suggested subjects</div>
              {matrix.discovery.suggestedSubjects.map((entry, idx) => (
                <div key={`subject-suggestion-${idx}`} style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.45 }}>
                  {entry.label}{entry.reason ? ` - ${entry.reason}` : ""}
                </div>
              ))}
            </div>
          ) : null}
          {matrix.discovery.suggestedAttributes?.length ? (
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 11, color: "var(--ck-muted)", fontWeight: 700 }}>Suggested attributes</div>
              {matrix.discovery.suggestedAttributes.map((entry, idx) => (
                <div key={`attribute-suggestion-${idx}`} style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.45 }}>
                  {entry.label}{entry.reason ? ` - ${entry.reason}` : ""}
                </div>
              ))}
            </div>
          ) : null}
          {matrix.discovery.notes ? (
            <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.45 }}>
              {matrix.discovery.notes}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
