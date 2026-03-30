import ScorePill from "./ScorePill";
import SourcesList from "./SourcesList";
import FollowUpThread from "./FollowUpThread";
import ConfidenceBadge from "./ConfidenceBadge";
import ArgumentList from "./ArgumentList";
import ResearchBriefBlock from "./ResearchBriefBlock";
import { getDimensionView } from "../lib/dimensionView";
import { getLatestAcceptedFollowUpAdjustment } from "../lib/scoring";

export default function DebateTab({
  uc,
  dims,
  fuInputs,
  onFuInputChange,
  fuLoading,
  onFollowUp,
  onDiscardArgument,
  onResolveFollowUpProposal,
}) {
  const phaseInitial = uc.debate?.find(d => d.phase === "initial");
  const phaseCritique = uc.debate?.find(d => d.phase === "critique");
  const phaseResponse = uc.debate?.find(d => d.phase === "response");

  if (!phaseInitial && uc.status !== "analyzing") {
    return <p style={{ color: "var(--ck-muted)", fontSize: 12 }}>Analysis not yet complete.</p>;
  }

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
        {phaseInitial && (
          <div style={{ background: "#edf2ff", border: "1px solid #c9d4ff", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "var(--ck-blue)", fontWeight: 700, marginBottom: 4 }}>ANALYST - INITIAL ASSESSMENT</div>
            <p style={{ fontSize: 12, color: "var(--ck-blue-ink)", margin: 0, lineHeight: 1.55 }}>
              Scored all {dims.length} dimensions based on market knowledge. See Dimensions tab for per-dimension evidence and full analysis.
            </p>
          </div>
        )}
        {phaseCritique?.content?.overallFeedback && (
          <div style={{ background: "var(--ck-warn-bg)", border: "1px solid var(--ck-warn-line)", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#935f00", fontWeight: 700, marginBottom: 4 }}>CRITIC - PEER REVIEW</div>
            <p style={{ fontSize: 12, color: "#694300", margin: 0, lineHeight: 1.55 }}>{phaseCritique.content.overallFeedback}</p>
            <SourcesList sources={phaseCritique.content?.sources} />
          </div>
        )}
        {phaseResponse?.content?.analystResponse && (
          <div style={{ background: "#edf2ff", border: "1px solid #c9d4ff", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "var(--ck-blue)", fontWeight: 700, marginBottom: 4 }}>ANALYST - FINAL RESPONSE</div>
            <p style={{ fontSize: 12, color: "var(--ck-blue-ink)", margin: 0, lineHeight: 1.55 }}>{phaseResponse.content.analystResponse}</p>
            <SourcesList sources={phaseResponse.content?.sources} />
          </div>
        )}
      </div>

      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-blue)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
        Per-Dimension Exchanges & Follow-Up Challenges
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {dims.map(d => {
          const view = getDimensionView(uc, d.id, { dimLabel: d.label });
          const initScore = view.initial?.score;
          const crit = phaseCritique?.content?.dimensions?.[d.id];
          const fin = phaseResponse?.content?.dimensions?.[d.id];
          const thread = uc.followUps?.[d.id] || [];
          const accepted = getLatestAcceptedFollowUpAdjustment(thread);
          const pmAdjustedScore = accepted?.score ?? null;
          const fuKey = `${uc.id}::${d.id}`;
          const loading = !!fuLoading[fuKey];

          if (!initScore) return null;

          const handleChallengeArgument = (arg) => {
            const summary = String(arg?.detail || "").trim();
            const challenge = `Please re-evaluate this ${arg?.group === "limiting" ? "limiting factor" : "supporting evidence"} argument: "${arg?.claim || arg?.id}". ${summary ? `Context: ${summary}` : ""}`.trim();
            onFollowUp(uc.id, d.id, challenge, {
              forceIntent: "challenge",
              targetArgument: {
                id: arg?.id,
                group: arg?.group,
                claim: arg?.claim,
                detail: arg?.detail,
              },
            });
          };

          const handleDiscardArgument = (arg) => {
            onDiscardArgument?.(uc.id, d.id, arg);
          };

          return (
            <div key={d.id} style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--ck-surface-soft)" }}>
                <span style={{ fontWeight: 700, color: "var(--ck-text)", fontSize: 13 }}>{d.label}</span>
                <ConfidenceBadge level={view.confidence} reason={view.confidenceReason} compact={true} />
                <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                  <ScorePill score={initScore} />
                  {fin?.finalScore != null && fin.finalScore !== initScore && (
                    <>
                      <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>-&gt;</span>
                      <ScorePill score={fin.finalScore} revised={true} />
                    </>
                  )}
                  {pmAdjustedScore != null && (
                    <>
                      <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>-&gt;</span>
                      <ScorePill score={pmAdjustedScore} revised={true} />
                      <span style={{ fontSize: 10, color: "#935f00", fontWeight: 700 }}>PM-REVISED</span>
                    </>
                  )}
                </div>
              </div>

              <div style={{ padding: "10px 14px 0", display: "grid", gap: 8 }}>
                <ArgumentList
                  group="supporting"
                  argumentsList={view.supportingArguments}
                  onChallenge={handleChallengeArgument}
                  onDiscard={handleDiscardArgument}
                  actionDisabled={loading}
                />
                <ArgumentList
                  group="limiting"
                  argumentsList={view.limitingArguments}
                  onChallenge={handleChallengeArgument}
                  onDiscard={handleDiscardArgument}
                  actionDisabled={loading}
                />
                {view.confidence === "low" && <ResearchBriefBlock brief={view.researchBrief} compact={true} />}
              </div>

              {crit && (
                <div style={{ padding: "10px 14px", borderTop: "1px solid var(--ck-line)", background: "var(--ck-warn-bg)" }}>
                  <div style={{ fontSize: 10, color: "#935f00", fontWeight: 700, marginBottom: 4 }}>
                    CRITIC {!crit.scoreJustified ? `- suggests ${crit.suggestedScore}/5` : "- score justified"}
                  </div>
                  <p style={{ fontSize: 12, color: "#694300", margin: 0, lineHeight: 1.6 }}>{crit.critique}</p>
                  <SourcesList sources={crit.sources} />
                </div>
              )}

              {fin && (
                <div style={{ padding: "10px 14px", borderTop: "1px solid var(--ck-line)", background: "#edf2ff" }}>
                  <div style={{ fontSize: 10, color: "var(--ck-blue)", fontWeight: 700, marginBottom: 4 }}>ANALYST</div>
                  <p style={{ fontSize: 12, color: "var(--ck-blue-ink)", margin: 0, lineHeight: 1.6 }}>{fin.response}</p>
                  <SourcesList sources={fin.sources} />
                </div>
              )}

              <div style={{ padding: "0 14px 14px" }}>
                <FollowUpThread
                  thread={thread}
                  inputVal={fuInputs[fuKey] || ""}
                  onInputChange={val => onFuInputChange(fuKey, val)}
                  onSubmit={() => onFollowUp(uc.id, d.id, fuInputs[fuKey] || "")}
                  onResolveProposal={(messageId, decision) => onResolveFollowUpProposal?.(uc.id, d.id, messageId, decision)}
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
