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

function argumentList(argumentsList = []) {
  const items = Array.isArray(argumentsList) ? argumentsList : [];
  if (!items.length) return null;
  return (
    <ul style={{ margin: "4px 0 0 16px", padding: 0, display: "grid", gap: 4 }}>
      {items.map((entry, idx) => (
        <li key={`arg-${idx}`} style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>
          <strong style={{ color: "var(--ck-text)" }}>{cleanText(entry?.claim) || "Claim"}:</strong>{" "}
          {cleanText(entry?.detail) || "No detail."}
        </li>
      ))}
    </ul>
  );
}

export default function MatrixDebateTab({
  uc,
  fuInputs,
  onFuInputChange,
  fuLoading,
  onFollowUpCell,
}) {
  const phaseInitial = Array.isArray(uc?.debate) ? uc.debate.find((entry) => entry.phase === "initial") : null;
  const phaseCritique = Array.isArray(uc?.debate) ? uc.debate.find((entry) => entry.phase === "critique") : null;
  const phaseResponse = Array.isArray(uc?.debate) ? uc.debate.find((entry) => entry.phase === "response") : null;
  const analystFinalText = cleanText(
    phaseResponse?.content?.analystResponse
    || phaseResponse?.content?.response
    || ""
  );

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
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
        {phaseInitial && (
          <div style={{ background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, marginBottom: 4 }}>ANALYST - INITIAL MATRIX ASSESSMENT</div>
            <p style={{ fontSize: 12, color: "var(--ck-blue-ink)", margin: 0, lineHeight: 1.55 }}>
              {cleanText(phaseInitial?.content?.note) || "Built initial matrix evidence and confidence across subject-attribute cells."}
            </p>
          </div>
        )}
        {cleanText(phaseCritique?.content?.overallFeedback) && (
          <div style={{ background: "var(--ck-warn-bg)", border: "1px solid var(--ck-warn-line)", borderRadius: 2, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, marginBottom: 4 }}>CRITIC - MATRIX REVIEW</div>
            <p style={{ fontSize: 12, color: "var(--ck-muted)", margin: 0, lineHeight: 1.55 }}>
              {cleanText(phaseCritique.content.overallFeedback)}
            </p>
          </div>
        )}
        {phaseResponse && (
          <div style={{ background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, marginBottom: 4 }}>ANALYST - FINAL MATRIX RESPONSE</div>
            <p style={{ fontSize: 12, color: "var(--ck-blue-ink)", margin: 0, lineHeight: 1.55 }}>
              {analystFinalText || "Resolved critic-raised matrix concerns and updated cell-level evidence where needed."}
            </p>
            <SourcesList sources={phaseResponse?.content?.sources} />
          </div>
        )}
      </div>

      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
        Per-Cell Exchanges & Follow-Up Challenges
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cellList.map(({ subject, attribute, cell }) => {
          const threadKey = matrixThreadKey(subject.id, attribute.id);
          const debateKey = `${subject.id}::${attribute.id}`;
          const critFromDebate = phaseCritique?.content?.cells?.[debateKey] || null;
          const responseFromDebate = phaseResponse?.content?.cells?.[debateKey] || null;
          const thread = followUps[threadKey] || [];
          const fuKey = `${uc.id}::${threadKey}`;
          const loading = !!fuLoading[fuKey];
          const sourceCount = Array.isArray(cell?.sources) ? cell.sources.length : 0;
          const subjectSummary = summaryMap.get(subject.id);
          const criticNote = cleanText(cell?.criticNote || critFromDebate?.critique);
          const analystNote = cleanText(cell?.analystNote || responseFromDebate?.response);
          const criticSources = Array.isArray(cell?.criticSources) ? cell.criticSources : (critFromDebate?.sources || []);
          const analystSources = Array.isArray(cell?.analystSources) ? cell.analystSources : (responseFromDebate?.sources || []);
          const criticSeverity = cleanText(critFromDebate?.severity || "").toLowerCase();
          const criticCategory = cleanText(critFromDebate?.category || "");
          const analystDisposition = cleanText(cell?.analystDecision || responseFromDebate?.disposition || "");
          const mitigationNote = cleanText(responseFromDebate?.mitigationNote || "");
          const hasCriticPanel = !!criticNote || !!criticSources?.length;
          const hasAnalystPanel = !!analystNote || !!analystSources?.length;

          return (
            <div key={`${subject.id}::${attribute.id}`} style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--ck-surface-soft)", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, color: "var(--ck-text)", fontSize: 13 }}>
                  {subject.label} - {attribute.label}
                </span>
                {cell ? (
                  <ConfidenceBadge level={cell.confidence} reason={cell.confidenceReason} compact={true} />
                ) : null}
                {cleanText(cell?.providerAgreement) ? (
                  <span style={{ fontSize: 10, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>
                    Provider: {cleanText(cell.providerAgreement)}
                  </span>
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
                {cleanText(cell?.full) ? (
                  <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.6 }}>
                    {cleanText(cell.full)}
                  </div>
                ) : null}
                {Array.isArray(cell?.arguments?.supporting) && cell.arguments.supporting.length ? (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>
                      Supporting Arguments
                    </div>
                    {argumentList(cell.arguments.supporting)}
                  </div>
                ) : null}
                {Array.isArray(cell?.arguments?.limiting) && cell.arguments.limiting.length ? (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>
                      Limiting Arguments
                    </div>
                    {argumentList(cell.arguments.limiting)}
                  </div>
                ) : null}
                {cleanText(cell?.risks) ? (
                  <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                    <strong style={{ color: "var(--ck-text)" }}>Risks:</strong> {cleanText(cell.risks)}
                  </div>
                ) : null}
                {hasCriticPanel ? (
                  <div style={{ padding: "8px 10px", border: "1px solid var(--ck-warn-line)", background: "var(--ck-warn-bg)", borderRadius: 2, fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                    <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, marginBottom: 3 }}>
                      CRITIC
                      {criticSeverity ? ` - ${criticSeverity.toUpperCase()}` : ""}
                      {criticCategory ? ` - ${criticCategory}` : ""}
                    </div>
                    {criticNote || "Flag raised for this cell."}
                    <SourcesList sources={criticSources} />
                  </div>
                ) : null}
                {hasAnalystPanel ? (
                  <div style={{ padding: "8px 10px", border: "1px solid var(--ck-line)", background: "var(--ck-surface-soft)", borderRadius: 2, fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                    <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, marginBottom: 3 }}>
                      ANALYST{analystDisposition ? ` - ${analystDisposition}` : ""}
                    </div>
                    {analystNote || "Analyst response recorded for this cell."}
                    {mitigationNote ? (
                      <div style={{ marginTop: 4 }}>
                        <strong style={{ color: "var(--ck-text)" }}>Mitigation:</strong> {mitigationNote}
                      </div>
                    ) : null}
                    <SourcesList sources={analystSources} />
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
