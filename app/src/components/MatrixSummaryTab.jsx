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

export default function MatrixSummaryTab({ uc }) {
  const matrix = uc?.matrix || {};
  const summary = matrix?.executiveSummary || {};
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const counts = agreementCounts(cells);
  const hasSummary = Object.values(summary).some((value) => cleanText(value));

  if (!hasSummary && !cells.length) {
    return (
      <div style={{ fontSize: 12, color: "var(--ck-muted)" }}>
        Executive summary is not available yet.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
          Executive Summary
        </div>
        {summaryRow("Decision Answer", summary?.decisionAnswer)}
        {summaryRow("Closest Threats", summary?.closestThreats)}
        {summaryRow("Whitespace", summary?.whitespace)}
        {summaryRow("Strategic Classification", summary?.strategicClassification)}
        {summaryRow("Key Risks", summary?.keyRisks)}
        {summaryRow("Decision Implications", summary?.decisionImplications)}
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
    </div>
  );
}
