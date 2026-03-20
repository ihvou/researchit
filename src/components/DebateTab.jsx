import ScorePill from "./ScorePill";
import SourcesList from "./SourcesList";
import FollowUpThread from "./FollowUpThread";

export default function DebateTab({ uc, dims, fuInputs, onFuInputChange, fuLoading, onFollowUp }) {
  const phaseInitial = uc.debate?.find(d => d.phase === "initial");
  const phaseCritique = uc.debate?.find(d => d.phase === "critique");
  const phaseResponse = uc.debate?.find(d => d.phase === "response");

  if (!phaseInitial && uc.status !== "analyzing") {
    return <p style={{ color: "#374151", fontSize: 12 }}>Analysis not yet complete.</p>;
  }

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
        {phaseInitial && (
          <div style={{ background: "#0c1828", border: "1px solid #1a3455", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700, marginBottom: 4 }}>{"\ud83d\udd0d"} ANALYST (Claude Sonnet 4.6) {"\u2014"} INITIAL ASSESSMENT</div>
            <p style={{ fontSize: 12, color: "#93c5fd", margin: 0, lineHeight: 1.55 }}>
              Scored all {dims.length} dimensions based on market knowledge. See Dimensions tab for per-dimension evidence and full analysis.
            </p>
          </div>
        )}
        {phaseCritique?.content?.overallFeedback && (
          <div style={{ background: "#120f00", border: "1px solid #504000", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#fbbf24", fontWeight: 700, marginBottom: 4 }}>{"\ud83e\uddd0"} CRITIC (OpenAI o3) {"\u2014"} PEER REVIEW</div>
            <p style={{ fontSize: 12, color: "#fde68a", margin: 0, lineHeight: 1.55 }}>{phaseCritique.content.overallFeedback}</p>
            <SourcesList sources={phaseCritique.content?.sources} />
          </div>
        )}
        {phaseResponse?.content?.analystResponse && (
          <div style={{ background: "#0c1828", border: "1px solid #1a3455", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700, marginBottom: 4 }}>{"\u2696\ufe0f"} ANALYST (Claude Sonnet 4.6) {"\u2014"} FINAL RESPONSE</div>
            <p style={{ fontSize: 12, color: "#93c5fd", margin: 0, lineHeight: 1.55 }}>{phaseResponse.content.analystResponse}</p>
            <SourcesList sources={phaseResponse.content?.sources} />
          </div>
        )}
      </div>

      <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
        Per-Dimension Exchanges & Follow-Up Challenges
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {dims.map(d => {
          const initScore = uc.dimScores?.[d.id]?.score;
          const crit = phaseCritique?.content?.dimensions?.[d.id];
          const fin = phaseResponse?.content?.dimensions?.[d.id];
          const thread = uc.followUps?.[d.id] || [];
          const fuAdjusted = thread.filter(m => m.role === "analyst" && m.scoreAdjusted && m.newScore != null);
          const pmAdjustedScore = fuAdjusted.length ? fuAdjusted[fuAdjusted.length - 1].newScore : null;
          const fuKey = `${uc.id}::${d.id}`;

          if (!initScore) return null;

          return (
            <div key={d.id} style={{ background: "#0a0d17", border: "1px solid #1a2030", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#0f1420" }}>
                <span style={{ fontWeight: 700, color: "#e2e8f0", fontSize: 13 }}>{d.label}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                  <ScorePill score={initScore} />
                  {fin?.finalScore != null && fin.finalScore !== initScore && (
                    <>
                      <span style={{ color: "#374151", fontSize: 11 }}>{"\u2192"}</span>
                      <ScorePill score={fin.finalScore} revised={true} />
                    </>
                  )}
                  {pmAdjustedScore != null && (
                    <>
                      <span style={{ color: "#374151", fontSize: 11 }}>{"\u2192"}</span>
                      <ScorePill score={pmAdjustedScore} revised={true} />
                      <span style={{ fontSize: 10, color: "#fbbf24", fontWeight: 700 }}>PM-REVISED</span>
                    </>
                  )}
                </div>
              </div>

              {crit && (
                <div style={{ padding: "10px 14px", borderTop: "1px solid #1a2030", background: "#110d00" }}>
                  <div style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700, marginBottom: 4 }}>
                    {"\ud83e\uddd0"} CRITIC {!crit.scoreJustified ? `\u00b7 suggests ${crit.suggestedScore}/5` : "\u00b7 score justified"}
                  </div>
                  <p style={{ fontSize: 12, color: "#fde68a", margin: 0, lineHeight: 1.6 }}>{crit.critique}</p>
                  <SourcesList sources={crit.sources} />
                </div>
              )}

              {fin && (
                <div style={{ padding: "10px 14px", borderTop: "1px solid #1a2030", background: "#0c1828" }}>
                  <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700, marginBottom: 4 }}>{"\u2696\ufe0f"} ANALYST</div>
                  <p style={{ fontSize: 12, color: "#93c5fd", margin: 0, lineHeight: 1.6 }}>{fin.response}</p>
                  <SourcesList sources={fin.sources} />
                </div>
              )}

              <div style={{ padding: "0 14px 14px" }}>
                <FollowUpThread
                  thread={thread}
                  inputVal={fuInputs[fuKey] || ""}
                  onInputChange={val => onFuInputChange(fuKey, val)}
                  onSubmit={() => onFollowUp(uc.id, d.id, fuInputs[fuKey] || "")}
                  loading={!!fuLoading[fuKey]}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
