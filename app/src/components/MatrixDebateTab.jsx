import SourcesList from "./SourcesList";
import FollowUpThread from "./FollowUpThread";
import ConfidenceBadge from "./ConfidenceBadge";

function cleanText(value) {
  return String(value || "").trim();
}

function matrixThreadKey(subjectId, attributeId) {
  return `matrix::${subjectId}::${attributeId}`;
}

function buildCellMap(cells = []) {
  const map = new Map();
  (cells || []).forEach((cell) => {
    map.set(`${cell.subjectId}::${cell.attributeId}`, cell);
  });
  return map;
}

export default function MatrixDebateTab({
  uc,
  fuInputs,
  onFuInputChange,
  fuLoading,
  onFollowUpCell,
}) {
  const matrix = uc?.matrix || {};
  const subjects = Array.isArray(matrix?.subjects) ? matrix.subjects : [];
  const attributes = Array.isArray(matrix?.attributes) ? matrix.attributes : [];
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const followUps = uc?.followUps && typeof uc.followUps === "object" ? uc.followUps : {};
  const subjectSummaries = Array.isArray(matrix?.subjectSummaries) ? matrix.subjectSummaries : [];
  const summaryMap = new Map();
  subjectSummaries.forEach((entry) => {
    summaryMap.set(entry.subjectId, cleanText(entry.summary));
  });
  const cellMap = buildCellMap(cells);

  if (!subjects.length || !attributes.length) {
    return (
      <p style={{ color: "var(--ck-muted)", fontSize: 12 }}>
        Matrix results are not available yet.
      </p>
    );
  }

  const cellList = subjects.flatMap((subject) => attributes.map((attribute) => ({
    subject,
    attribute,
    cell: cellMap.get(`${subject.id}::${attribute.id}`) || null,
  })));

  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
        Per-Cell Exchanges & Follow-Up Challenges
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cellList.map(({ subject, attribute, cell }) => {
          const threadKey = matrixThreadKey(subject.id, attribute.id);
          const thread = followUps[threadKey] || [];
          const fuKey = `${uc.id}::${threadKey}`;
          const loading = !!fuLoading[fuKey];
          const sourceCount = Array.isArray(cell?.sources) ? cell.sources.length : 0;
          const subjectSummary = summaryMap.get(subject.id);

          return (
            <div key={`${subject.id}::${attribute.id}`} style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--ck-surface-soft)", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, color: "var(--ck-text)", fontSize: 13 }}>
                  {subject.label} - {attribute.label}
                </span>
                {cell ? (
                  <ConfidenceBadge level={cell.confidence} reason={cell.confidenceReason} compact={true} />
                ) : null}
                <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--ck-muted)", fontWeight: 700 }}>
                  {sourceCount} source{sourceCount === 1 ? "" : "s"}
                </div>
              </div>

              <div style={{ padding: "10px 14px", display: "grid", gap: 8 }}>
                {subjectSummary ? (
                  <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                    Subject summary: {subjectSummary}
                  </div>
                ) : null}
                {attribute?.brief ? (
                  <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                    Attribute scope: {attribute.brief}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.6 }}>
                  {cleanText(cell?.value) || "No evidence captured."}
                </div>
                {cell?.contested && cleanText(cell?.criticNote) ? (
                  <div style={{ padding: "8px 10px", border: "1px solid var(--ck-warn-line)", background: "var(--ck-warn-bg)", borderRadius: 2, fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                    Critic: {cleanText(cell.criticNote)}
                  </div>
                ) : null}
                {cleanText(cell?.analystNote) ? (
                  <div style={{ padding: "8px 10px", border: "1px solid var(--ck-line)", background: "var(--ck-surface-soft)", borderRadius: 2, fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                    Analyst: {cleanText(cell.analystNote)}
                  </div>
                ) : null}
                {sourceCount > 0 ? <SourcesList sources={cell.sources} /> : null}
              </div>

              <div style={{ padding: "0 14px 14px" }}>
                <FollowUpThread
                  thread={thread}
                  inputVal={fuInputs[fuKey] || ""}
                  onInputChange={(val) => onFuInputChange(fuKey, val)}
                  onSubmit={() => onFollowUpCell?.(uc.id, subject.id, attribute.id, fuInputs[fuKey] || "")}
                  loading={loading}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
