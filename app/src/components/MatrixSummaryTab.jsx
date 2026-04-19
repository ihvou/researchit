function cleanText(value) {
  return String(value || "").trim();
}

function agreementCounts(cells = []) {
  const counts = { agree: 0, partial: 0, contradict: 0, single: 0, none: 0 };
  (cells || []).forEach((cell) => {
    const key = cleanText(cell?.providerAgreement).toLowerCase() || "none";
    if (Object.prototype.hasOwnProperty.call(counts, key)) {
      counts[key] += 1;
    } else {
      counts.none += 1;
    }
  });
  return counts;
}

function summaryRow(label, value) {
  if (!cleanText(value)) return null;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.7 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.6 }}>
        {value}
      </div>
    </div>
  );
}

function normalizeSourceUniverse(summary = {}) {
  return {
    cited: Number(summary?.cited || 0),
    corroborating: Number(summary?.corroborating || 0),
    unverified: Number(summary?.unverified || 0),
    excludedMarketing: Number(summary?.excludedMarketing || 0),
    excludedStale: Number(summary?.excludedStale || 0),
    total: Number(summary?.total || 0),
  };
}

function redTeamSeverityCounts(cells = {}) {
  const counts = { high: 0, medium: 0, low: 0 };
  Object.values(cells || {}).forEach((entry) => {
    const severity = cleanText(entry?.severityIfWrong).toLowerCase();
    if (severity === "high" || severity === "medium" || severity === "low") counts[severity] += 1;
  });
  return counts;
}

export default function MatrixSummaryTab({ uc }) {
  const matrix = uc?.matrix || {};
  const summary = matrix?.executiveSummary || {};
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const counts = agreementCounts(cells);
  const hasSummary = Object.values(summary).some((value) => cleanText(value));
  const sourceUniverse = normalizeSourceUniverse(uc?.analysisMeta?.sourceUniverse);
  const showSourceUniverse = sourceUniverse.total > 0;
  const redTeam = matrix?.redTeam || {};
  const decisionGate = uc?.analysisMeta?.decisionGradeGate && typeof uc.analysisMeta.decisionGradeGate === "object"
    ? uc.analysisMeta.decisionGradeGate
    : null;
  const decisionGradeEnabled = !!decisionGate?.enabled;
  const decisionGradePassed = decisionGradeEnabled ? !!uc?.analysisMeta?.decisionGradePassed : true;
  const decisionGradeFailureReason = cleanText(uc?.analysisMeta?.decisionGradeFailureReason);
  const redTeamCells = redTeam?.cells && typeof redTeam.cells === "object" ? redTeam.cells : {};
  const redTeamCounts = redTeamSeverityCounts(redTeamCells);
  const subjectLabelMap = new Map((Array.isArray(matrix?.subjects) ? matrix.subjects : []).map((item) => [item.id, item.label || item.id]));
  const attributeLabelMap = new Map((Array.isArray(matrix?.attributes) ? matrix.attributes : []).map((item) => [item.id, item.label || item.id]));
  const redTeamRows = Object.entries(redTeamCells)
    .map(([key, entry]) => {
      const [subjectId, attributeId] = String(key).split("::");
      return {
        key,
        subjectLabel: subjectLabelMap.get(subjectId) || subjectId || "Unknown subject",
        attributeLabel: attributeLabelMap.get(attributeId) || attributeId || "Unknown attribute",
        threat: cleanText(entry?.threat),
        missedRisk: cleanText(entry?.missedRisk),
        severityIfWrong: cleanText(entry?.severityIfWrong).toLowerCase() || "medium",
      };
    })
    .filter((entry) => entry.threat || entry.missedRisk);

  if (!hasSummary && !cells.length) {
    return (
      <div style={{ fontSize: 12, color: "var(--ck-muted)" }}>
        Executive summary is not available yet.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {decisionGradeEnabled ? (
        <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            Decision Grade
          </div>
          <div style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.55 }}>
            {decisionGradePassed ? "Passed. This run meets decision-grade checks." : "Not passed. Continue evidence recovery before using this output for hard go/no-go decisions."}
          </div>
          {!decisionGradePassed && decisionGradeFailureReason ? (
            <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
              {decisionGradeFailureReason}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
          Executive Summary
        </div>
        {summaryRow("Decision Answer", summary?.decisionAnswer)}
        {summaryRow("Closest Threats", summary?.closestThreats)}
        {summaryRow("Whitespace", summary?.whitespace)}
        {summaryRow("Strategic Classification", summary?.strategicClassification)}
        {summaryRow("Key Risks", summary?.keyRisks)}
        {summaryRow("Decision Implications", summary?.decisionImplication || summary?.decisionImplications)}
        {summaryRow("Uncertainty Notes", summary?.uncertaintyNotes)}
      </div>

      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
          Provider Agreement
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12, color: "var(--ck-text)" }}>
          <span>Agree: {counts.agree}</span>
          <span>Partial: {counts.partial}</span>
          <span>Contradict: {counts.contradict}</span>
          <span>Single: {counts.single}</span>
        </div>
        {cleanText(summary?.providerAgreementHighlights) ? (
          <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.55 }}>
            {summary.providerAgreementHighlights}
          </div>
        ) : null}
      </div>

      {showSourceUniverse ? (
        <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            Source Quality
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12, color: "var(--ck-text)" }}>
            <span>Cited: {sourceUniverse.cited}</span>
            <span>Corroborating: {sourceUniverse.corroborating}</span>
            <span>Unverified: {sourceUniverse.unverified}</span>
            <span>Excluded marketing: {sourceUniverse.excludedMarketing}</span>
            <span>Excluded stale: {sourceUniverse.excludedStale}</span>
            <span>Total: {sourceUniverse.total}</span>
          </div>
        </div>
      ) : null}

      {(cleanText(redTeam?.redTeamVerdict) || redTeamRows.length) ? (
        <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            Red Team
          </div>
          {cleanText(redTeam?.redTeamVerdict) ? (
            <div style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.55 }}>
              {redTeam.redTeamVerdict}
            </div>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, color: "var(--ck-muted)" }}>
            <span>High severity: {redTeamCounts.high}</span>
            <span>Medium severity: {redTeamCounts.medium}</span>
            <span>Low severity: {redTeamCounts.low}</span>
          </div>
          {redTeamRows.length ? (
            <div style={{ display: "grid", gap: 6 }}>
              {redTeamRows.slice(0, 10).map((entry) => (
                <div key={`matrix-red-team-${entry.key}`} style={{ border: "1px solid var(--ck-line)", background: "var(--ck-surface-soft)", borderRadius: 2, padding: "7px 9px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-text)", marginBottom: 2 }}>
                    {entry.subjectLabel} - {entry.attributeLabel}
                  </div>
                  {entry.threat ? (
                    <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>
                      <strong style={{ color: "var(--ck-text)" }}>Threat:</strong> {entry.threat}
                    </div>
                  ) : null}
                  {entry.missedRisk ? (
                    <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>
                      <strong style={{ color: "var(--ck-text)" }}>Missed risk:</strong> {entry.missedRisk}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
