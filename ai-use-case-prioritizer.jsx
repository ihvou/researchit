import { useState, useRef, useEffect } from "react";

// ─── 11 DIMENSIONS ────────────────────────────────────────────────────────────
const DEFAULT_DIMS = [
  {
    id: "roi", label: "ROI Magnitude", weight: 18, enabled: true,
    brief: "Scale of verifiable financial impact — cost savings, revenue uplift, or loss prevention per deployment",
    fullDef: `Score 5 (>$50M per deployment or >$500M industry-wide): Audited P&L or press-release-verified outcomes. E.g. Mastercard fraud prevention ($50B/3yrs), JPMorgan LLM Suite ($1.5B stated annual value), CommonSpirit Health RCM ($100M+/yr), Aviva motor claims (£60M in 2024).
Score 4 ($10M–$50M): Clear operational metrics with credible financial proxy — FTE redeployment, asset downtime reduction, denial-rate reduction with modeled revenue impact.
Score 3 ($1M–$10M): Real production deployments but self-reported or operational metrics only (hours saved, cycle time, FTEs avoided). No independent verification.
Score 2 (<$1M or soft metrics only): Satisfaction scores, NPS, adoption rate without financial translation. Or very early-stage deployments.
Score 1 (Unverified / projected): ROI estimated or projected only. No production deployments with measured, repeatable financial outcomes.`
  },
  {
    id: "ai_fit", label: "AI Applicability", weight: 14, enabled: true,
    brief: "How fundamentally AI-suited this problem is — versus traditional software, rules engines, RPA, or offshore BPO",
    fullDef: `Score 5 (Uniquely AI): Essentially unsolvable at production scale without AI. Requires real-time pattern recognition in unstructured data, language understanding, or inference across millions of daily events. 100× headcount otherwise. Examples: ambient clinical documentation, real-time fraud detection, computer vision defect inspection.
Score 4 (Strong advantage): AI provides 5–10× improvement over traditional approaches in accuracy, speed, or scale. Rules-based systems exist but degrade badly at edge cases or high volume.
Score 3 (Meaningful improvement): AI improves on traditional approaches but traditional still works acceptably — efficiency gain, not a fundamental new capability.
Score 2 (Marginal advantage): Traditional RPA, rule engines, or offshore BPO achieves 70%+ of the outcome at lower cost and lower delivery risk.
Score 1 (Poor fit): Problem is primarily workflow or process design. AI adds marginal value over good software engineering or process improvement. Risk of over-engineering.`
  },
  {
    id: "evidence", label: "Evidence Density", weight: 13, enabled: true,
    brief: "Number and quality of verified real-world enterprise deployments with quantified, repeatable ROI in this specific use case",
    fullDef: `Score 5 (5+ named enterprises, audited or press-verified): Peer-reviewed studies or earnings call disclosures available. Outcomes replicable across geographies and company sizes. Pattern is clearly established.
Score 4 (3–5 named companies, specific metrics): Named executives or vendor case studies with verifiable claims. Financial or strong operational metrics.
Score 3 (2–3 named companies, operational metrics): Hours saved, cycle time, FTEs — rather than pure financial outcomes. May be limited to specific geographies or company sizes.
Score 2 (1–2 companies, self-reported): Metrics without independent verification. May be limited to pilot or early deployment stages.
Score 1 (Anecdotal or pilot only): No production deployments with measured, repeatable outcomes. POC stage only.`
  },
  {
    id: "ttv", label: "Time to Value", weight: 11, enabled: true,
    brief: "Speed from project kick-off to client seeing measurable, reportable ROI — faster reduces client risk and improves deal velocity",
    fullDef: `Score 5 (60–90 days): ROI visible within one quarter. Can be demonstrated in a time-boxed pilot before full deployment commitment. Very low client risk.
Score 4 (3–6 months): Standard enterprise integration timeline. ROI measurable post go-live within a typical budget year. Manageable risk.
Score 3 (6–12 months): Full ROI requires data preparation, integration work, and change management ramp-up. Normal for complex enterprise AI.
Score 2 (12–18 months): Significant organizational change or extended data collection required before the model performs reliably. High budget-cycle risk.
Score 1 (>18 months or fundamentally unclear): ROI requires multi-year platform transformation. High deal risk — unlikely to survive a budget cycle or leadership change.`
  },
  {
    id: "data_readiness", label: "Client Data Readiness", weight: 9, enabled: true,
    brief: "Whether target clients typically have the data infrastructure this solution needs — or if data prep dominates the project budget",
    fullDef: `Score 5 (Data ready): Already digitized, structured, and accessible in standard enterprise systems (ERP, CRM, EHR). Minimal data prep before model training or RAG indexing.
Score 4 (Minor prep, 2–4 weeks): Data exists digitally but requires ETL, cleansing, or consolidation. Normal project setup work, not a risk.
Score 3 (Significant prep, 1–3 months): Data partially digitized. Historical labeling, de-duplication, or structuring required before AI development begins.
Score 2 (Major challenge, 3–6 months): Data largely in paper, legacy systems, or siloed across departments. Substantial infrastructure work required before AI layer.
Score 1 (Data doesn't exist): Requires IoT sensor deployment, new logging processes, or multi-year data accumulation. No viable training data at most target clients.`
  },
  {
    id: "feasibility", label: "Build Feasibility", weight: 9, enabled: true,
    brief: "Technical complexity for an outsourcing AI delivery team — without deep domain-specific R&D or specialized hardware capabilities",
    fullDef: `Score 5 (Straightforward): Composable with cloud AI services (Azure OpenAI, AWS Bedrock, GCP Vertex AI) and standard open-source libraries. No proprietary hardware or novel research required. Team of 3–5 can deliver in 2–3 months.
Score 4 (Moderate): Requires prompt engineering expertise, RAG architecture design, or supervised fine-tuning. Evaluation framework needed. 5–8 person team, 3–5 months.
Score 3 (Complex): Dedicated ML engineers AND domain SMEs required. Custom model training, MLOps pipelines, evaluation harness. 8–12 people, 6–12 months.
Score 2 (Specialist): Specialized hardware (edge inference, robotics, medical-grade sensors), OT/SCADA integration, or FDA-cleared software development required.
Score 1 (R&D-level): Novel architecture, proprietary research platform, or 18+ month investment. Not achievable without a dedicated research function.`
  },
  {
    id: "market_size", label: "Market Size", weight: 7, enabled: true,
    brief: "Total number of potential client engagements globally — determines pipeline ceiling for this use case",
    fullDef: `Score 5 (10,000+ potential buyers globally): Horizontal use case applicable across multiple industries — document processing, customer service AI, enterprise knowledge search, developer productivity.
Score 4 (1,000–10,000 buyers): Strong vertical with identifiable decision-makers and dedicated AI budget lines. Clear TAM with named buyer personas.
Score 3 (500–1,000 buyers): Clear niche with recurring need and demonstrated willingness to commission custom delivery.
Score 2 (100–500 buyers): Specialized vertical or geography-constrained opportunity. Good for a focused niche strategy.
Score 1 (<100 buyers or hyper-niche): Limited replication potential even after successful first delivery. Hard to build a repeatable practice.`
  },
  {
    id: "build_vs_buy", label: "Build vs. Buy Pressure", weight: 9, enabled: true,
    brief: "Does a mature off-the-shelf SaaS already solve this well enough that clients buy a license instead of commissioning a custom delivery project?",
    fullDef: `OUTSOURCING DELIVERY CONTEXT: Score 5 = no dominant SaaS exists, clients MUST commission custom delivery. Score 1 = dominant SaaS means no delivery project opportunity exists.

Score 5 (High custom demand): No dominant SaaS product. Clients must build or heavily customize. Outsourcer is the natural and often only path to implementation.
Score 4 (Customization always required): Products exist but none fully solve at enterprise scale without significant custom integration. Outsourcer adds clear, defensible value in every deal.
Score 3 (Implementation track available): Established SaaS requires 3–6 months of implementation and configuration work. Outsourcer can own the implementation track, though margin is lower.
Score 2 (Limited integration role): 1–2 dominant platforms solve 80%+ of the problem out of the box. Outsourcer role is limited to lower-value configuration and light integration only.
Score 1 (Commodity SaaS, no project): Salesforce, ServiceNow, Microsoft Copilot, or similar fully covers it. Clients self-configure or use the vendor's professional services. No natural custom delivery project.`
  },
  {
    id: "regulatory", label: "Regulatory & Compliance Risk", weight: 8, enabled: true,
    brief: "How much regulatory complexity will expand scope, delay delivery timeline, or create shared liability for the outsourcing team",
    fullDef: `Score 5 (Low risk): Standard data privacy (GDPR, CCPA) only. No sector-specific AI approval required. Manageable with standard enterprise privacy controls and DPAs.
Score 4 (Manageable overhead): HIPAA, SOX, or PCI compliance required but well-understood. Adds 2–4 weeks of compliance work. Outsourcer has standard playbooks for these.
Score 3 (Notable overhead): EU AI Act high-risk classification, FCA model risk requirements, or formal audit trail mandated. Adds 1–3 months and requires a compliance specialist on the team.
Score 2 (Significant barrier): FDA 510(k) clearance, FCA formal model approval, or full SR 11-7 model risk compliance pathway required. 6–18 month process outside the delivery team's control.
Score 1 (Blocking risk): Multiple overlapping regulatory frameworks (e.g. EU AI Act + sector-specific + data residency). Deployment contingent on regulatory approval that may never come. Outsourcer carries shared liability risk.`
  },
  {
    id: "change_mgmt", label: "Change Management", weight: 8, enabled: true,
    brief: "Organizational resistance and adoption complexity the client faces — the single leading cause of AI project failure post-build",
    fullDef: `Score 5 (Minimal disruption): Augments existing workflow with no visible role disruption. Users adopt organically with minimal training. No role elimination, union involvement, or C-suite mandate required.
Score 4 (Moderate change): Requires training and process adjustment for one team or department. No role elimination. Change limited in scope and duration — manageable with a standard adoption playbook.
Score 3 (Significant change): Redesigns workflows across multiple teams or business units. Some role displacement. Formal change management program is required and adds to scope, timeline, and cost.
Score 2 (Major transformation): Role elimination at scale, potential union negotiation, or C-suite-mandated change program. High political risk inside the client organization. Requires dedicated OCM workstream.
Score 1 (High failure risk): Workforce-wide transformation with strong, documented internal resistance. Similar AI deployments at comparable companies have been rolled back or failed publicly.`
  },
  {
    id: "reusability", label: "Reusability / Productization", weight: 7, enabled: true,
    brief: "Can this solution be repackaged across multiple clients — building IP assets that compound the outsourcer's margin on repeat engagements",
    fullDef: `Score 5 (<20% customization per repeat client): Core model, prompt library, evaluation framework, connectors, and deployment scripts are all reusable. Second and third clients are significantly faster to deliver at higher margin. Clear proprietary IP asset.
Score 4 (40–60% reuse): Architecture and tooling transfer to new clients in the same vertical. Domain-specific components are tuned per client but the heavy lifting is done.
Score 3 (30–40% reuse): Common patterns emerge after 2–3 deliveries. IP accumulates slowly but each engagement still requires significant re-engineering. Productization takes 3–4 clients.
Score 2 (Low reuse, ~20%): Highly bespoke to each client's data, processes, and integration stack. Minimal IP accumulates across engagements.
Score 1 (No reuse, staff augmentation): Every engagement is effectively a clean-sheet build. No productization path. Revenue scales only with headcount.`
  },
];

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────
const SYS_ANALYST = `You are a senior AI product analyst at an outsourcing company that delivers CUSTOM AI solutions for enterprise clients — not SaaS products. Your job is to assess whether a use case represents a strong custom-delivery opportunity.

Rules:
- Cite REAL named companies with SPECIFIC metrics (numbers, percentages, dollar values)
- Include real URLs where known (vendor sites, news outlets, research papers, earnings calls, press releases)
- Direct quotes must be paraphrased and kept under 15 words — never reproduce copyrighted text verbatim
- Score conservatively — an overconfident 5 is worse than a calibrated 3
- Return ONLY valid JSON — no markdown, no backticks, no preamble`;

const SYS_CRITIC = `You are a skeptical AI investment analyst reviewing a peer's assessment for an outsourcing delivery company. Your job is to challenge overconfident scores, name real SaaS products and incumbent vendors that threaten the delivery opportunity, and push back on weak evidence.

Rules:
- Be genuinely analytical — not a rubber stamp
- Name specific real SaaS platforms, vendors, or incumbents that reduce the delivery opportunity
- Cite named sources with real URLs when challenging claims
- Direct quotes must be paraphrased and under 15 words
- Return ONLY valid JSON — no markdown, no backticks, no preamble`;

const SYS_ANALYST_RESPONSE = `You are a senior AI product analyst responding to a critic's peer review. Be intellectually honest: concede valid points with revised scores AND clear reasoning. Defend valid scores with NEW specific evidence not mentioned in your initial assessment.

Rules:
- Cite named sources with real URLs in your defense
- Direct quotes paraphrased, under 15 words
- If you revise a score, explain exactly why the critic's point was valid
- Return ONLY valid JSON — no markdown, no backticks, no preamble`;

const SYS_FOLLOWUP = `You are a senior AI product analyst responding to a direct challenge from the Product Manager about a specific dimension. Be intellectually honest and direct. Concede with a revised score if the challenge is valid. Defend with NEW specific evidence not previously cited if it is not.

Rules:
- Never repeat evidence you have already given — only new sources count as a valid defense
- Cite named sources with real URLs
- Direct quotes paraphrased, under 15 words
- Return ONLY valid JSON — no markdown, no backticks, no preamble`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function buildDimRubrics(dims) {
  return dims.map(d =>
    `### ${d.label} [id: "${d.id}"]\nBrief: ${d.brief}\nDetailed Rubric:\n${d.fullDef}`
  ).join("\n\n");
}

function getEffectiveScore(uc, dimId) {
  const fuAdjusted = (uc.followUps?.[dimId] || [])
    .filter(f => f.role === "analyst" && f.scoreAdjusted && f.newScore != null);
  const lastAdj = fuAdjusted.length ? fuAdjusted[fuAdjusted.length - 1].newScore : null;
  return lastAdj
    ?? uc.finalScores?.dimensions?.[dimId]?.finalScore
    ?? uc.dimScores?.[dimId]?.score
    ?? null;
}

function calcWeightedScore(uc, dims) {
  if (!uc.dimScores) return null;
  const active = dims.filter(d => d.enabled);
  if (!active.length) return null;
  let wSum = 0, wTotal = 0;
  active.forEach(d => {
    const sc = getEffectiveScore(uc, d.id);
    if (sc != null) { wSum += sc * d.weight; wTotal += d.weight; }
  });
  return wTotal ? ((wSum / wTotal / 5) * 100).toFixed(1) : null;
}

function dimScoreColor(v) {
  if (v >= 4.5) return "#10b981";
  if (v >= 3.5) return "#22c55e";
  if (v >= 2.5) return "#f59e0b";
  if (v >= 1.5) return "#f97316";
  return "#ef4444";
}
function totalScoreColor(t) {
  const n = parseFloat(t);
  if (n >= 80) return "#10b981";
  if (n >= 65) return "#22c55e";
  if (n >= 50) return "#f59e0b";
  if (n >= 35) return "#f97316";
  return "#ef4444";
}

async function callAPI(messages, systemPrompt, maxTokens = 5000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const textBlock = data.content?.find(b => b.type === "text");
  if (!textBlock) throw new Error("No text content in API response");
  return textBlock.text;
}

function safeParseJSON(raw) {
  const clean = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in response");

  // Try clean slice up to last closing brace first
  const end = clean.lastIndexOf("}");
  if (end !== -1) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) { /* fall through to repair */ }
  }

  // Response was truncated mid-JSON — attempt structural repair by
  // closing any unclosed strings, arrays, and objects
  let s = clean.slice(start);
  // Close any unclosed string (odd number of unescaped quotes after last key)
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) s += '"';
  // Count unclosed brackets/braces
  let opens = 0, openArr = 0;
  for (const ch of s) {
    if (ch === "{") opens++;
    else if (ch === "}") opens--;
    else if (ch === "[") openArr++;
    else if (ch === "]") openArr--;
  }
  // Close from inside-out
  s += "]".repeat(Math.max(0, openArr));
  s += "}".repeat(Math.max(0, opens));

  try { return JSON.parse(s); }
  catch (e) { throw new Error(`JSON parse failed even after repair attempt: ${e.message}`); }
}

// ─── MICRO COMPONENTS ────────────────────────────────────────────────────────
function Spinner({ size = 12, color = "#a855f7" }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      border: "2px solid #ffffff14", borderTopColor: color,
      borderRadius: "50%", animation: "spin .75s linear infinite", flexShrink: 0,
    }} />
  );
}

function ScorePill({ score, revised = false }) {
  const c = dimScoreColor(score);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      background: c + "22", border: `1.5px solid ${c}55`,
      color: c, padding: "2px 8px", borderRadius: 6,
      fontWeight: 700, fontSize: 12, fontFamily: "monospace", whiteSpace: "nowrap",
    }}>
      {score}/5{revised && <span style={{ fontSize: 8, opacity: 0.8, marginLeft: 1 }}>▲</span>}
    </span>
  );
}

function TotalPill({ score }) {
  const c = totalScoreColor(score);
  const n = parseFloat(score);
  const tier = n >= 80 ? "★★★" : n >= 65 ? "★★" : n >= 50 ? "★" : "–";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      background: c + "1a", border: `1.5px solid ${c}88`,
      color: c, padding: "3px 10px", borderRadius: 8, fontWeight: 800, fontSize: 13,
    }}>
      <span style={{ fontFamily: "monospace" }}>{score}</span>
      <span style={{ fontSize: 10, letterSpacing: 1 }}>{tier}</span>
    </span>
  );
}

function SourcesList({ sources }) {
  if (!sources?.length) return null;
  return (
    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "3px 0" }}>
      <span style={{ fontSize: 10, color: "#4b5563", textTransform: "uppercase", letterSpacing: 0.7, marginRight: 6, flexShrink: 0 }}>
        Sources:
      </span>
      {sources.map((s, i) => (
        <span key={i} style={{
          display: "inline-flex", alignItems: "baseline", gap: 4,
          background: "#111827", border: "1px solid #1e2d3d",
          borderRadius: 5, padding: "2px 8px", fontSize: 11, marginRight: 5, marginBottom: 3,
        }}>
          {s.url
            ? <a href={s.url} target="_blank" rel="noopener noreferrer"
                style={{ color: "#60a5fa", textDecoration: "none" }}
                onMouseOver={e => e.target.style.textDecoration = "underline"}
                onMouseOut={e => e.target.style.textDecoration = "none"}>
                {s.name}
              </a>
            : <span style={{ color: "#60a5fa" }}>{s.name}</span>}
          {s.quote && <span style={{ color: "#374151" }}>· {s.quote}</span>}
        </span>
      ))}
    </div>
  );
}

function EvidenceBlock({ brief, full, sources, risks }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <p style={{ fontSize: 12, color: "#cbd5e1", margin: "0 0 6px", lineHeight: 1.7 }}>{brief}</p>
      {(full || sources?.length || risks) && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{ background: "none", border: "none", color: "#7c3aed", fontSize: 11, padding: 0, cursor: "pointer", marginBottom: expanded ? 10 : 0 }}>
            {expanded ? "▲ Collapse full analysis" : "▼ Full analysis & sources"}
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

function DimRubricToggle({ dim }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8, lineHeight: 1.5 }}>
      {dim.brief}{" "}
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ background: "none", border: "none", color: "#6d28d9", fontSize: 11, padding: 0, cursor: "pointer" }}>
        {open ? "▲ hide rubric" : "▼ scoring rubric"}
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

// ─── FOLLOW-UP THREAD ────────────────────────────────────────────────────────
function FollowUpThread({ thread, inputVal, onInputChange, onSubmit, loading }) {
  const [collapsed, setCollapsed] = useState(false);
  const hasMessages = thread?.length > 0;
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed #1a2535" }}>
      {hasMessages && (
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={() => setCollapsed(v => !v)}
            style={{ background: "none", border: "none", color: "#4b5563", fontSize: 11, padding: "0 0 6px", cursor: "pointer" }}>
            {collapsed
              ? `▶ ${thread.length} follow-up message${thread.length > 1 ? "s" : ""} — expand`
              : "▼ Follow-up thread"}
          </button>
          {!collapsed && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {thread.map((msg, i) => {
                const isPM = msg.role === "pm";
                return (
                  <div key={i} style={{
                    background: isPM ? "#0c1828" : "#0a1812",
                    border: `1px solid ${isPM ? "#1a3455" : "#163020"}`,
                    borderRadius: 8, padding: "8px 12px",
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: isPM ? "#93c5fd" : "#86efac" }}>
                      {isPM ? "🙋 Your Challenge" : "🔍 Analyst Response"}
                      {!isPM && msg.scoreAdjusted && msg.newScore != null &&
                        <span style={{ color: "#fbbf24", marginLeft: 8, fontWeight: 400 }}>
                          · Score revised to {msg.newScore}/5
                        </span>}
                    </div>
                    <p style={{ fontSize: 12, color: isPM ? "#bfdbfe" : "#bbf7d0", margin: "0 0 4px", lineHeight: 1.65 }}>
                      {msg.text || msg.response}
                    </p>
                    {!isPM && msg.sources?.length > 0 && <SourcesList sources={msg.sources} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        <textarea
          value={inputVal}
          onChange={e => onInputChange(e.target.value)}
          placeholder={'Challenge this score… e.g. "Salesforce already does this — does that change the score?" (⌘+Enter to send)'}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && inputVal?.trim() && !loading) onSubmit();
          }}
          style={{
            flex: 1, background: "#07090f", border: "1px solid #1e2535", borderRadius: 7,
            color: "#e2e8f0", padding: "7px 10px", fontSize: 11, resize: "none",
            minHeight: 50, lineHeight: 1.5, outline: "none", fontFamily: "inherit",
          }}
        />
        <button
          onClick={onSubmit}
          disabled={!inputVal?.trim() || loading}
          style={{
            background: inputVal?.trim() && !loading ? "#7c3aed" : "#101420",
            border: "none",
            color: inputVal?.trim() && !loading ? "#fff" : "#2d3748",
            padding: "8px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600,
            flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
          }}>
          {loading ? <><Spinner size={10} color="#a855f7" /><span style={{ color: "#a855f7" }}>…</span></> : "Send ↗"}
        </button>
      </div>
    </div>
  );
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
function OverviewTab({ uc, dims }) {
  const a = uc.attributes;
  const score = calcWeightedScore(uc, dims);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 14 }}>
      <div style={{ background: "#0f1520", borderRadius: 10, padding: "14px 16px", border: "1px solid #1e2a3a" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
          Use Case Attributes
        </div>
        {a ? (
          <>
            {[
              ["Vertical", a.vertical],
              ["Buyer", a.buyerPersona],
              ["AI Type", a.aiSolutionType],
              ["Timeline", a.typicalTimeline],
              ["Delivery Model", a.deliveryModel],
            ].map(([k, v]) => v && (
              <div key={k} style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "flex-start" }}>
                <span style={{ color: "#4b5563", fontSize: 11, minWidth: 80, paddingTop: 1, flexShrink: 0 }}>{k}</span>
                <span style={{ color: "#cbd5e1", fontSize: 12, fontWeight: 500, lineHeight: 1.4 }}>{v}</span>
              </div>
            ))}
            {a.expandedDescription && (
              <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.65, margin: "12px 0 0", borderTop: "1px solid #1e2a3a", paddingTop: 12 }}>
                {a.expandedDescription}
              </p>
            )}
          </>
        ) : (
          <span style={{ color: "#374151", fontSize: 12 }}>Analyzing…</span>
        )}
      </div>

      <div style={{ background: "#0f1520", borderRadius: 10, padding: "14px 16px", border: "1px solid #1e2a3a" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
          Score Summary
        </div>
        {dims.map(d => {
          const sc = getEffectiveScore(uc, d.id);
          const initScore = uc.dimScores?.[d.id]?.score;
          const finalScore = uc.finalScores?.dimensions?.[d.id]?.finalScore;
          const revised = finalScore != null && initScore != null && finalScore !== initScore;
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8, opacity: d.enabled ? 1 : 0.35 }}>
              <div style={{ minWidth: 52 }}>
                {sc != null
                  ? <ScorePill score={sc} revised={revised} />
                  : <span style={{ color: "#2d3748", fontSize: 12 }}>–</span>}
              </div>
              <div>
                <div style={{ fontSize: 12, color: d.enabled ? "#e2e8f0" : "#4b5563", fontWeight: 600, lineHeight: 1.3 }}>
                  {d.label}
                  <span style={{ color: "#374151", fontWeight: 400, fontSize: 10, marginLeft: 4 }}>{d.weight}%</span>
                  {!d.enabled && <span style={{ color: "#374151", fontSize: 10, marginLeft: 4 }}>(excluded)</span>}
                </div>
                {uc.dimScores?.[d.id]?.brief && (
                  <div style={{ fontSize: 11, color: "#4b5563", marginTop: 1, lineHeight: 1.4 }}>
                    {uc.dimScores[d.id].brief}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {uc.finalScores?.conclusion && (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "#0a0d17", borderRadius: 8, fontSize: 12, color: "#94a3b8", borderLeft: "3px solid #7c3aed", lineHeight: 1.7 }}>
            {uc.finalScores.conclusion}
          </div>
        )}
        {score && (
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "#4b5563" }}>Weighted score:</span>
            <TotalPill score={score} />
          </div>
        )}
      </div>
    </div>
  );
}

function DimensionsTab({ uc, dims }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {dims.map(d => {
        const initData = uc.dimScores?.[d.id];
        const finalData = uc.finalScores?.dimensions?.[d.id];
        const effScore = getEffectiveScore(uc, d.id);
        const revised = finalData?.finalScore != null && initData?.score != null && finalData.finalScore !== initData.score;

        if (!initData) {
          return (
            <div key={d.id} style={{ background: "#0f1520", borderRadius: 8, padding: "10px 14px", opacity: 0.25, border: "1px solid #141820" }}>
              <span style={{ color: "#4b5563", fontSize: 12 }}>{d.label}</span>
            </div>
          );
        }
        return (
          <div key={d.id} style={{ background: "#0f1520", borderRadius: 10, padding: "14px 16px", border: `1px solid ${d.enabled ? "#1e2a3a" : "#141820"}`, opacity: d.enabled ? 1 : 0.5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontWeight: 700, color: "#e2e8f0", fontSize: 13 }}>{d.label}</span>
              {!d.enabled && (
                <span style={{ fontSize: 10, color: "#374151", background: "#0a0d17", padding: "1px 6px", borderRadius: 4 }}>excluded from score</span>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center" }}>
                {revised && (
                  <>
                    <ScorePill score={initData.score} />
                    <span style={{ color: "#374151", fontSize: 11 }}>→</span>
                  </>
                )}
                {effScore != null && <ScorePill score={effScore} revised={revised} />}
                {revised && <span style={{ fontSize: 10, color: "#10b981", fontWeight: 700 }}>REVISED</span>}
              </div>
            </div>
            <DimRubricToggle dim={d} />
            <EvidenceBlock
              brief={initData.brief}
              full={initData.full}
              sources={initData.sources}
              risks={initData.risks}
            />
          </div>
        );
      })}
    </div>
  );
}

function DebateTab({ uc, dims, fuInputs, onFuInputChange, fuLoading, onFollowUp }) {
  const phaseInitial = uc.debate?.find(d => d.phase === "initial");
  const phaseCritique = uc.debate?.find(d => d.phase === "critique");
  const phaseResponse = uc.debate?.find(d => d.phase === "response");

  if (!phaseInitial && uc.status !== "analyzing") {
    return <p style={{ color: "#374151", fontSize: 12 }}>Analysis not yet complete.</p>;
  }

  return (
    <div>
      {/* Top-level debate messages */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
        {phaseInitial && (
          <div style={{ background: "#0c1828", border: "1px solid #1a3455", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700, marginBottom: 4 }}>🔍 ANALYST — INITIAL ASSESSMENT</div>
            <p style={{ fontSize: 12, color: "#93c5fd", margin: 0, lineHeight: 1.55 }}>
              Scored all {dims.length} dimensions based on market knowledge. See Dimensions tab for per-dimension evidence and full analysis.
            </p>
          </div>
        )}
        {phaseCritique?.content?.overallFeedback && (
          <div style={{ background: "#120f00", border: "1px solid #504000", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#fbbf24", fontWeight: 700, marginBottom: 4 }}>🧐 CRITIC — PEER REVIEW</div>
            <p style={{ fontSize: 12, color: "#fde68a", margin: 0, lineHeight: 1.55 }}>{phaseCritique.content.overallFeedback}</p>
            <SourcesList sources={phaseCritique.content?.sources} />
          </div>
        )}
        {phaseResponse?.content?.analystResponse && (
          <div style={{ background: "#0c1828", border: "1px solid #1a3455", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700, marginBottom: 4 }}>⚖️ ANALYST — FINAL RESPONSE</div>
            <p style={{ fontSize: 12, color: "#93c5fd", margin: 0, lineHeight: 1.55 }}>{phaseResponse.content.analystResponse}</p>
            <SourcesList sources={phaseResponse.content?.sources} />
          </div>
        )}
      </div>

      {/* Per-dimension exchanges */}
      <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
        Per-Dimension Exchanges &amp; Follow-Up Challenges
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
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "#0f1420" }}>
                <span style={{ fontWeight: 700, color: "#e2e8f0", fontSize: 13 }}>{d.label}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                  <ScorePill score={initScore} />
                  {fin?.finalScore != null && fin.finalScore !== initScore && (
                    <>
                      <span style={{ color: "#374151", fontSize: 11 }}>→</span>
                      <ScorePill score={fin.finalScore} revised={true} />
                    </>
                  )}
                  {pmAdjustedScore != null && (
                    <>
                      <span style={{ color: "#374151", fontSize: 11 }}>→</span>
                      <ScorePill score={pmAdjustedScore} revised={true} />
                      <span style={{ fontSize: 10, color: "#fbbf24", fontWeight: 700 }}>PM-REVISED</span>
                    </>
                  )}
                </div>
              </div>

              {/* Critic challenge */}
              {crit && (
                <div style={{ padding: "10px 14px", borderTop: "1px solid #1a2030", background: "#110d00" }}>
                  <div style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700, marginBottom: 4 }}>
                    🧐 CRITIC {!crit.scoreJustified ? `· suggests ${crit.suggestedScore}/5` : "· score justified"}
                  </div>
                  <p style={{ fontSize: 12, color: "#fde68a", margin: 0, lineHeight: 1.6 }}>{crit.critique}</p>
                  <SourcesList sources={crit.sources} />
                </div>
              )}

              {/* Analyst response */}
              {fin && (
                <div style={{ padding: "10px 14px", borderTop: "1px solid #1a2030", background: "#0c1828" }}>
                  <div style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700, marginBottom: 4 }}>⚖️ ANALYST</div>
                  <p style={{ fontSize: 12, color: "#93c5fd", margin: 0, lineHeight: 1.6 }}>{fin.response}</p>
                  <SourcesList sources={fin.sources} />
                </div>
              )}

              {/* Follow-up thread */}
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

function ExpandedRow({ uc, dims, fuInputs, onFuInputChange, fuLoading, onFollowUp }) {
  const [tab, setTab] = useState("overview");
  const PHASE_LABELS = {
    analyst: "🔍 Analyst researching…",
    critic: "🧐 Critic reviewing…",
    finalizing: "⚖️ Analyst responding…",
  };

  return (
    <div style={{ borderTop: "2px solid #5b21b633" }}>
      {/* Tab bar */}
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #1e2a3a", background: "#0f1420", padding: "0 16px" }}>
        {[
          { id: "overview", label: "📋 Overview" },
          { id: "dimensions", label: "📊 Dimensions" },
          { id: "debate", label: "💬 Debate & Challenges" },
        ].map(t => (
          <button
            key={t.id}
            onClick={e => { e.stopPropagation(); setTab(t.id); }}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t.id ? "2px solid #a855f7" : "2px solid transparent",
              color: tab === t.id ? "#a855f7" : "#4b5563",
              padding: "9px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 10, padding: "0 8px" }}>
          {uc.status === "analyzing"
            ? <span style={{ color: "#a855f7", display: "flex", alignItems: "center", gap: 6 }}>
                <Spinner size={10} /> {PHASE_LABELS[uc.phase] || "Processing…"}
              </span>
            : <span style={{ color: "#2d3748" }}>
                claude-sonnet-4-20250514 · Sources are training-based — verify before use
              </span>}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ padding: 16, background: "#080b14" }}>
        {uc.status === "error" && (
          <div style={{ background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "10px 14px", color: "#fca5a5", fontSize: 13, marginBottom: 14 }}>
            ⚠️ {uc.errorMsg}
          </div>
        )}
        {tab === "overview" && <OverviewTab uc={uc} dims={dims} />}
        {tab === "dimensions" && <DimensionsTab uc={uc} dims={dims} />}
        {tab === "debate" && (
          <DebateTab
            uc={uc} dims={dims}
            fuInputs={fuInputs} onFuInputChange={onFuInputChange}
            fuLoading={fuLoading} onFollowUp={onFollowUp}
          />
        )}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [useCases, setUseCases] = useState([]);
  const [dims, setDims] = useState(DEFAULT_DIMS);
  const [inputText, setInputText] = useState("");
  const [showInputPanel, setShowInputPanel] = useState(false);
  const [showDimsPanel, setShowDimsPanel] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [globalAnalyzing, setGlobalAnalyzing] = useState(false);
  const [fuInputs, setFuInputs] = useState({});
  const [fuLoading, setFuLoading] = useState({});

  const ucRef = useRef(useCases);
  useEffect(() => { ucRef.current = useCases; }, [useCases]);

  function updateUC(id, fn) {
    setUseCases(prev => prev.map(u => u.id === id ? fn(u) : u));
  }

  function setFuInput(key, val) {
    setFuInputs(prev => ({ ...prev, [key]: val }));
  }

  async function runAnalysis() {
    const desc = inputText.trim();
    if (!desc || globalAnalyzing) return;

    const id = Date.now().toString();
    const blankUC = {
      id, rawInput: desc, status: "analyzing", phase: "analyst",
      attributes: null, dimScores: null, critique: null, finalScores: null,
      debate: [], followUps: {}, errorMsg: null,
    };

    setUseCases(prev => [...prev, blankUC]);
    setShowInputPanel(false);
    setInputText("");
    setExpandedId(id);
    setGlobalAnalyzing(true);

    // Build per-dimension template for phase 1 prompt
    const dimJsonTemplate = dims.map(d =>
      `"${d.id}": {
        "score": <integer 1-5 based on rubric>,
        "brief": "<single sentence summary, max 25 words>",
        "full": "<detailed 3-5 paragraph analysis citing named companies with specific metrics, trends, and market context>",
        "sources": [
          {"name": "<source name>", "quote": "<paraphrased insight, max 15 words>", "url": "<real URL if known, else omit field>"}
        ],
        "risks": "<1-2 sentences on key risks or caveats for this dimension>"
      }`
    ).join(",\n    ");

    const phase1Prompt = `Analyze this AI use case for an outsourcing company that builds CUSTOM AI solutions for enterprise clients:

"${desc}"

SCORING DIMENSIONS — use the rubric below to score each one 1-5:
${buildDimRubrics(dims)}

Return ONLY this exact JSON structure, fully populated for ALL 11 dimension IDs (${dims.map(d => d.id).join(", ")}):

{
  "attributes": {
    "title": "<descriptive title, max 8 words>",
    "expandedDescription": "<2-3 sentences: what the AI does, how it creates value, why an outsourcer should care>",
    "vertical": "<primary industry vertical>",
    "buyerPersona": "<job title of primary decision maker>",
    "aiSolutionType": "<specific AI/ML technology type>",
    "typicalTimeline": "<realistic end-to-end delivery estimate>",
    "deliveryModel": "<how outsourcer engages: build-and-transfer, managed service, etc>"
  },
  "dimensions": {
    ${dimJsonTemplate}
  }
}`;

    const debate = [];

    try {
      // ─ Phase 1: Analyst ───────────────────────────────────────────────────
      updateUC(id, u => ({ ...u, phase: "analyst" }));
      let r1, p1;
      try {
        r1 = await callAPI([{ role: "user", content: phase1Prompt }], SYS_ANALYST, 12000);
        p1 = safeParseJSON(r1);
      } catch (parseErr) {
        // Retry with a condensed prompt — shorter "full" fields to stay within token budget
        console.warn("Phase 1 parse failed, retrying with condensed prompt:", parseErr.message);
        const condensedDimTemplate = dims.map(d =>
          `"${d.id}": {"score": <1-5>, "brief": "<max 20 words>", "full": "<1 paragraph, max 80 words, cite 1-2 named companies>", "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}], "risks": "<max 20 words>"}`
        ).join(",\n    ");
        const condensedPrompt = `Analyze this AI use case for an outsourcing company building CUSTOM AI solutions:

"${desc}"

SCORING DIMENSIONS (score each 1-5 using these rubrics):
${buildDimRubrics(dims)}

Return ONLY this JSON (ALL 11 dimension IDs: ${dims.map(d => d.id).join(", ")}):
{
  "attributes": {"title": "<max 8 words>", "expandedDescription": "<2 sentences>", "vertical": "<industry>", "buyerPersona": "<role>", "aiSolutionType": "<AI/ML type>", "typicalTimeline": "<estimate>", "deliveryModel": "<engagement type>"},
  "dimensions": {
    ${condensedDimTemplate}
  }
}`;
        r1 = await callAPI([{ role: "user", content: condensedPrompt }], SYS_ANALYST, 8000);
        p1 = safeParseJSON(r1);
      }

      debate.push({ phase: "initial", content: p1 });
      updateUC(id, u => ({ ...u, attributes: p1.attributes, dimScores: p1.dimensions, phase: "critic", debate: [...debate] }));

      // ─ Phase 2: Critic ────────────────────────────────────────────────────
      const phase2Prompt = `Review this analyst assessment of the AI use case: "${p1.attributes?.title || desc}"

Analyst scores (outsourcing delivery context):
${dims.map(d => `• ${d.label} [${d.id}]: ${p1.dimensions?.[d.id]?.score}/5 — ${p1.dimensions?.[d.id]?.brief || ""}`).join("\n")}

Return ONLY this JSON:
{
  "overallFeedback": "<2-3 sentence overall critique — what is the analyst getting right and wrong?>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map(d => `"${d.id}": {
      "scoreJustified": <true if score is defensible, false if over/under-stated>,
      "suggestedScore": <your suggested score 1-5>,
      "critique": "<2-3 sentences: specific challenge with named incumbent vendors, SaaS products, or counter-evidence>",
      "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
    }`).join(",\n    ")}
  }
}`;

      const r2 = await callAPI([{ role: "user", content: phase2Prompt }], SYS_CRITIC, 5000);
      const p2 = safeParseJSON(r2);

      debate.push({ phase: "critique", content: p2 });
      updateUC(id, u => ({ ...u, critique: p2, phase: "finalizing", debate: [...debate] }));

      // ─ Phase 3: Analyst responds ──────────────────────────────────────────
      const phase3Prompt = `You are the analyst who assessed "${p1.attributes?.title || desc}".

Your original scores:
${dims.map(d => `• ${d.label}: ${p1.dimensions?.[d.id]?.score}/5`).join("\n")}

Critic's overall feedback: ${p2.overallFeedback || ""}

Per-dimension critiques:
${dims.map(d => {
  const c = p2.dimensions?.[d.id];
  return `• ${d.label}: ${c?.scoreJustified ? "Score justified" : `Critic suggests ${c?.suggestedScore}/5`} — ${c?.critique || "no specific challenge"}`;
}).join("\n")}

Respond per dimension: defend your score with NEW evidence not previously cited, OR concede and revise with clear reasoning.

Return ONLY this JSON:
{
  "analystResponse": "<2-3 sentence overall response to the critique>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map(d => `"${d.id}": {
      "finalScore": <your final score 1-5 — may differ from original>,
      "scoreChanged": <true if you revised the score>,
      "response": "<3-4 sentences: concede or defend with new specific evidence>",
      "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
    }`).join(",\n    ")}
  },
  "conclusion": "<2-3 sentence strategic recommendation: should the outsourcing company pursue this, and how?>"
}`;

      const r3 = await callAPI([{ role: "user", content: phase3Prompt }], SYS_ANALYST_RESPONSE, 6000);
      const p3 = safeParseJSON(r3);

      debate.push({ phase: "response", content: p3 });
      updateUC(id, u => ({ ...u, finalScores: p3, status: "complete", phase: "complete", debate: [...debate] }));

    } catch (err) {
      console.error("Analysis error:", err);
      updateUC(id, u => ({ ...u, status: "error", phase: "error", errorMsg: err.message }));
    }
    setGlobalAnalyzing(false);
  }

  async function handleFollowUp(ucId, dimId, challenge) {
    if (!challenge.trim()) return;
    const fuKey = `${ucId}::${dimId}`;
    setFuLoading(prev => ({ ...prev, [fuKey]: true }));
    setFuInput(fuKey, "");

    // Add PM message immediately
    updateUC(ucId, u => ({
      ...u,
      followUps: {
        ...u.followUps,
        [dimId]: [...(u.followUps?.[dimId] || []), { role: "pm", text: challenge }],
      },
    }));

    const uc = ucRef.current.find(u => u.id === ucId);
    const dim = dims.find(d => d.id === dimId);
    const effScore = getEffectiveScore(uc, dimId);
    const dimData = uc.dimScores?.[dimId];
    const existingThread = uc.followUps?.[dimId] || [];

    const threadHistory = existingThread
      .map(m => m.role === "pm" ? `PM: ${m.text}` : `Analyst: ${m.response || m.text}`)
      .join("\n\n");

    const prompt = `Dimension being challenged: "${dim?.label}"
Use case: "${uc.attributes?.title || uc.rawInput}"
Current effective score: ${effScore}/5

Your original brief analysis: ${dimData?.brief || ""}
Your full analysis: ${dimData?.full || ""}

${threadHistory ? `Previous exchanges in this thread:\n${threadHistory}\n\n` : ""}PM's new challenge: "${challenge}"

Respond directly to the challenge. If valid, concede with a revised score AND clear reasoning. If not valid, defend with NEW evidence not previously cited (repeating prior evidence is not a valid defense).

Return ONLY this JSON:
{
  "response": "<3-5 sentences — direct, substantive, analytical>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "scoreAdjusted": <true if you are revising the score, false otherwise>,
  "newScore": <null if no revision, or integer 1-5 if revised>
}`;

    try {
      const result = await callAPI([{ role: "user", content: prompt }], SYS_FOLLOWUP, 2000);
      const parsed = safeParseJSON(result);
      updateUC(ucId, u => ({
        ...u,
        followUps: {
          ...u.followUps,
          [dimId]: [...(u.followUps?.[dimId] || []), { role: "analyst", ...parsed }],
        },
      }));
    } catch (err) {
      updateUC(ucId, u => ({
        ...u,
        followUps: {
          ...u.followUps,
          [dimId]: [...(u.followUps?.[dimId] || []), {
            role: "analyst", response: `Error: ${err.message}`,
            sources: [], scoreAdjusted: false, newScore: null,
          }],
        },
      }));
    }
    setFuLoading(prev => ({ ...prev, [fuKey]: false }));
  }

  const activeDims = dims.filter(d => d.enabled);
  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);

  const PHASE_LABEL_SHORT = {
    analyst: "🔍 Research…",
    critic: "🧐 Critique…",
    finalizing: "⚖️ Debate…",
  };

  return (
    <div style={{ minHeight: "100vh", background: "#07090f", color: "#e2e8f0", fontFamily: "system-ui,-apple-system,sans-serif", fontSize: 14 }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-thumb { background: #2d3748; border-radius: 3px; }
        button { cursor: pointer; font-family: inherit; }
        input, textarea { font-family: inherit; }
        a:hover { text-decoration: underline; }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{
        background: "#0a0d17", borderBottom: "1px solid #141a28",
        padding: "11px 20px", display: "flex", alignItems: "center", gap: 12,
        position: "sticky", top: 0, zIndex: 20,
      }}>
        <div>
          <span style={{ fontWeight: 800, fontSize: 15, color: "#a855f7" }}>AI Use Case Prioritizer</span>
          <span style={{ color: "#2d3748", fontSize: 12, marginLeft: 10 }}>
            11 dimensions · analyst ↔ critic debate · per-dimension challenges · outsourcing delivery focus
          </span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowDimsPanel(v => !v)}
            style={{
              background: showDimsPanel ? "#3b0764" : "#0f1520",
              border: "1px solid #2d3748", color: "#c084fc",
              padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
            }}>
            ⚙ Dimensions {showDimsPanel ? "▲" : "▼"}
          </button>
          <button
            onClick={() => setShowInputPanel(v => !v)}
            style={{ background: "#7c3aed", border: "none", color: "#fff", padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700 }}>
            + Add Use Case
          </button>
        </div>
      </div>

      {/* ── DIMENSIONS PANEL ── */}
      {showDimsPanel && (
        <div style={{ background: "#0a0d17", borderBottom: "1px solid #141a28", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            Scoring Dimensions &amp; Weights — toggle to exclude from weighted score
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(290px,1fr))", gap: 10, marginBottom: 12 }}>
            {dims.map(d => (
              <div key={d.id} style={{
                background: "#0f1520", border: `1px solid ${d.enabled ? "#1e2a3a" : "#141820"}`,
                borderRadius: 8, padding: "10px 14px", opacity: d.enabled ? 1 : 0.5,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <input
                    type="checkbox" checked={d.enabled}
                    onChange={e => setDims(p => p.map(x => x.id === d.id ? { ...x, enabled: e.target.checked } : x))}
                    style={{ accentColor: "#a855f7", width: 14, height: 14 }} />
                  <span style={{ fontWeight: 600, fontSize: 12, color: d.enabled ? "#e2e8f0" : "#4b5563" }}>{d.label}</span>
                  <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 12, color: "#a855f7", fontWeight: 700 }}>{d.weight}%</span>
                </div>
                <DimRubricToggle dim={d} />
                <input
                  type="range" min={1} max={40} step={1} value={d.weight}
                  disabled={!d.enabled}
                  onChange={e => setDims(p => p.map(x => x.id === d.id ? { ...x, weight: +e.target.value } : x))}
                  style={{ width: "100%", accentColor: "#7c3aed", marginTop: 4 }} />
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#374151" }}>
            Total weight: <span style={{ color: "#a855f7", fontWeight: 700 }}>{totalWeight}%</span>
            <span style={{ marginLeft: 8 }}>— scores auto-normalize, only relative weights matter</span>
          </div>
        </div>
      )}

      {/* ── INPUT PANEL ── */}
      {showInputPanel && (
        <div style={{ background: "#0a0d17", borderBottom: "1px solid #141a28", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            New Use Case — describe the problem or solution
          </div>
          <textarea
            autoFocus
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder={'Vague and high-level is fine. E.g. "AI for insurance claims processing" or "automate contract review for legal teams in financial services" or "predictive maintenance for manufacturing equipment"'}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAnalysis(); }}
            style={{
              width: "100%", height: 90, background: "#07090f", border: "1px solid #2d3748",
              borderRadius: 8, color: "#e2e8f0", padding: "10px 14px", fontSize: 13,
              resize: "vertical", lineHeight: 1.5, outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
            <button
              onClick={runAnalysis}
              disabled={!inputText.trim() || globalAnalyzing}
              style={{
                background: "#7c3aed", border: "none", color: "#fff",
                padding: "8px 20px", borderRadius: 8, fontWeight: 700, fontSize: 13,
                opacity: !inputText.trim() || globalAnalyzing ? 0.5 : 1,
                display: "flex", alignItems: "center", gap: 6,
              }}>
              {globalAnalyzing ? <><Spinner size={11} color="#fff" /> Analyzing…</> : "⚡ Analyze — 3-phase debate"}
            </button>
            <span style={{ fontSize: 11, color: "#2d3748" }}>⌘/Ctrl+Enter to submit</span>
            <button
              onClick={() => setShowInputPanel(false)}
              style={{ marginLeft: "auto", background: "transparent", border: "1px solid #2d3748", color: "#6b7280", padding: "7px 14px", borderRadius: 8, fontSize: 12 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── MAIN TABLE ── */}
      <div style={{ padding: 20 }}>
        {useCases.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 20px" }}>
            <div style={{ fontSize: 44, marginBottom: 14 }}>🤖</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#2d3748", marginBottom: 8 }}>No use cases yet</div>
            <div style={{ fontSize: 13, color: "#1f2937" }}>
              Click <strong style={{ color: "#a855f7" }}>+ Add Use Case</strong> to start the 3-phase analyst ↔ critic analysis
            </div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#0a0d17", borderBottom: "2px solid #141a28" }}>
                  <th style={{ textAlign: "left", padding: "10px 14px", color: "#4b5563", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, minWidth: 200 }}>
                    Use Case
                  </th>
                  {activeDims.map(d => (
                    <th key={d.id} style={{ textAlign: "center", padding: "8px 4px", color: "#4b5563", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, whiteSpace: "nowrap", minWidth: 66 }}>
                      {d.label
                        .replace("Applicability", "App.")
                        .replace("Readiness", "Ready")
                        .replace("Feasibility", "Build")
                        .replace("Management", "Mgmt")
                        .replace("Productization", "Reuse")
                        .replace("Pressure", "Pres.")}
                      <br />
                      <span style={{ color: "#2d3748", fontWeight: 400 }}>{d.weight}%</span>
                    </th>
                  ))}
                  <th style={{ textAlign: "center", padding: "10px 14px", color: "#a855f7", fontSize: 11, fontWeight: 700, textTransform: "uppercase", minWidth: 90 }}>
                    Score
                  </th>
                  <th style={{ width: 28 }} />
                </tr>
              </thead>
              <tbody>
                {useCases.map(uc => {
                  const score = calcWeightedScore(uc, dims);
                  const isExpanded = expandedId === uc.id;
                  return [
                    <tr
                      key={uc.id}
                      onClick={() => setExpandedId(isExpanded ? null : uc.id)}
                      style={{
                        borderBottom: isExpanded ? "none" : "1px solid #0f1218",
                        cursor: "pointer",
                        background: isExpanded ? "#0a0d17" : "transparent",
                      }}
                      onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = "#0c0f18"; }}
                      onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ fontWeight: 600, color: "#e2e8f0", marginBottom: 4, lineHeight: 1.3 }}>
                          {uc.attributes?.title || (uc.rawInput.length > 55 ? uc.rawInput.slice(0, 55) + "…" : uc.rawInput)}
                        </div>
                        {uc.attributes?.vertical && (
                          <span style={{ fontSize: 11, color: "#4b5563", background: "#0f1520", padding: "1px 7px", borderRadius: 4 }}>
                            {uc.attributes.vertical}
                          </span>
                        )}
                      </td>
                      {activeDims.map(d => {
                        const sc = getEffectiveScore(uc, d.id);
                        const initScore = uc.dimScores?.[d.id]?.score;
                        const finScore = uc.finalScores?.dimensions?.[d.id]?.finalScore;
                        const revised = finScore != null && initScore != null && finScore !== initScore;
                        return (
                          <td key={d.id} style={{ textAlign: "center", padding: "12px 4px" }}>
                            {sc != null
                              ? <ScorePill score={sc} revised={revised} />
                              : uc.status === "analyzing"
                                ? <Spinner size={10} />
                                : <span style={{ color: "#2d3748" }}>–</span>}
                          </td>
                        );
                      })}
                      <td style={{ textAlign: "center", padding: "12px 14px" }}>
                        {score
                          ? <TotalPill score={score} />
                          : uc.status === "error"
                            ? <span style={{ color: "#ef4444", fontSize: 11 }}>Error</span>
                            : uc.status === "analyzing"
                              ? <span style={{ color: "#4b5563", fontSize: 11 }}>{PHASE_LABEL_SHORT[uc.phase] || "…"}</span>
                              : "–"}
                      </td>
                      <td style={{ textAlign: "center", color: "#374151", fontSize: 12 }}>
                        {isExpanded ? "▲" : "▼"}
                      </td>
                    </tr>,
                    isExpanded && (
                      <tr key={uc.id + "_expanded"}>
                        <td colSpan={activeDims.length + 3} style={{ padding: 0 }}>
                          <ExpandedRow
                            uc={uc} dims={dims}
                            fuInputs={fuInputs}
                            onFuInputChange={setFuInput}
                            fuLoading={fuLoading}
                            onFollowUp={handleFollowUp}
                          />
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
