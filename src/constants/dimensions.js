export const DEFAULT_DIMS = [
  {
    id: "roi", label: "ROI Magnitude", weight: 18, enabled: true,
    brief: "Scale of verifiable financial impact - cost savings, revenue uplift, or loss prevention achievable at deployment scale in this vertical, assessed relatively where absolute figures are unavailable",
    fullDef: `IMPORTANT: Thresholds reflect industry-wide pattern at scale across multiple
named enterprises, not a single pilot or vendor projection. Where absolute dollar
figures are unavailable (mid-market verticals, emerging markets), use the
relative proxy: percentage of total operating cost impacted. A use case that
saves 8% of operating cost in a mid-market company is a Score 4 even if the
absolute figure is below $10M.

Score 5 (>$50M industry-wide or >10% operating cost, audited or press-verified):
Audited P&L, earnings call disclosure, or press-release-verified outcomes at
multiple named enterprises. Pattern is clearly established and replicable across
geographies and company sizes. Examples: Mastercard fraud prevention ($50B/3yrs),
JPMorgan LLM Suite ($1.5B stated annual value), CommonSpirit Health RCM
($100M+/yr), Aviva motor claims (GBP60M in 2024).

Score 4 ($10M-$50M or 5-10% operating cost, multiple named deployments): Clear
operational metrics with credible financial proxy at 3+ named enterprises - FTE
redeployment at scale, significant asset downtime reduction, denial-rate reduction
with modeled revenue impact. Not independently audited but credibly sourced.

Score 3 ($1M-$10M or 1-5% operating cost, self-reported): Real production
deployments but self-reported or operational metrics only - hours saved, cycle
time reduction, FTEs avoided. 1-2 named companies. No independent verification.

Score 2 (<$1M or soft metrics only): Satisfaction scores, NPS, adoption rate,
or productivity gains without financial translation. Or early-stage deployments
without a measurable financial outcome yet established.

Score 1 (Unverified or projected only): ROI estimated or modeled only. No
production deployments with measured, repeatable financial outcomes. Analyst
projections without named enterprise validation do not qualify.`
  },
  {
    id: "ai_fit", label: "AI Applicability", weight: 14, enabled: true,
    brief: "How fundamentally AI-suited this problem is - versus traditional software, rules engines, RPA, or offshore BPO delivering equivalent quality and throughput",
    fullDef: `Score 5 (Uniquely AI): Essentially unsolvable at production scale without AI.
Requires real-time pattern recognition in unstructured data, language understanding,
or inference across millions of daily events. Traditional approaches would require
100x the headcount at the same output quality. Examples: ambient clinical
documentation, real-time fraud detection at transaction scale, computer vision
defect inspection on a moving production line.

Score 4 (Strong advantage): AI provides 5-10x improvement over traditional
approaches in accuracy, speed, or throughput at comparable total cost. Rules-based
systems exist but degrade badly at edge cases or volume. The quality gap between
AI and non-AI is clearly measurable and business-significant.

Score 3 (Meaningful improvement): AI improves on traditional approaches but
traditional still works acceptably - efficiency gain of 30-70% productivity
improvement, not a fundamental new capability. The business case depends on
cost reduction, not a capability that is otherwise unavailable.

Score 2 (Marginal advantage): Traditional RPA, rule engines, or offshore BPO
achieves 70%+ of the output quality and throughput at comparable or lower total
cost and lower delivery risk. AI adds marginal improvement that may not justify
the project cost and complexity.

Score 1 (Poor fit): Problem is primarily workflow or process design. AI adds
marginal value over good software engineering or process improvement alone.
High risk of over-engineering a problem that a rules engine or simple automation
solves adequately.`
  },
  {
    id: "evidence", label: "Evidence Density", weight: 13, enabled: true,
    brief: "Number and quality of verified real-world deployments sufficiently similar in vertical, scale, and AI approach to be predictive for this specific use case - broad category evidence alone does not qualify",
    fullDef: `CRITICAL SCORING RULE: Evidence must be for deployments sufficiently similar
in vertical, scale, and AI approach to be meaningfully predictive. Broad
category evidence without vertical or scale match scores no higher than 3.
"AI is used in healthcare" is not evidence for "AI-powered prior authorization
for mid-market US health plans." Score the specificity of the match, not
the existence of the category.

Score 5 (5+ named enterprises, similar context, audited or press-verified):
Peer-reviewed studies or earnings call disclosures available. Outcomes replicable
across geographies and company sizes comparable to the target. Pattern is clearly
established. Confidence in predicted outcome is high.

Score 4 (3-5 named companies, similar vertical and scale, specific metrics):
Named executives or vendor case studies with verifiable claims. Financial or
strong operational metrics. Deployments are similar enough in vertical and
scale to be directly predictive for this use case.

Score 3 (2-3 deployments, adjacent context): Deployments exist but in a
different vertical, significantly larger enterprise scale, or meaningfully
different AI approach. Operational metrics (hours saved, FTEs) rather than
financial. Extrapolation is required to apply the evidence to this specific
context - score reflects the extrapolation gap.

Score 2 (1-2 deployments, weak contextual match): Self-reported metrics without
independent verification, or deployments in a significantly different context.
Evidence is directional only - not reliably predictive for this specific use case.

Score 1 (Anecdotal, pilot-stage, or category-level only): No production deployments
with measured outcomes in a comparable context. Evidence amounts to "this category
of AI exists" rather than "this specific use case has been validated at scale."`
  },
  {
    id: "ttv", label: "Time to Value", weight: 11, enabled: true,
    brief: "Speed from project kick-off to client seeing measurable, reportable ROI - measured from delivery start, not from sales cycle start",
    fullDef: `SCOPE NOTE: This dimension measures delivery-to-outcome speed, not
sales-cycle-to-outcome. A use case with a 90-day delivery cycle preceded
by an 18-month procurement process scores 5 here - the procurement risk
sits elsewhere. Score based on time elapsed from project kick-off (contract
signed, access granted) to first measurable, reportable client ROI.

Score 5 (60-90 days): ROI visible within one quarter of delivery start.
Demonstrable in a time-boxed pilot before full deployment commitment. Outcome
is visible within a single budget period - very low client risk.

Score 4 (3-6 months): Standard enterprise integration timeline. ROI measurable
post go-live within a typical budget year. Client can report impact within the
same fiscal year of engagement.

Score 3 (6-12 months): Full ROI requires data preparation, integration work,
and change management ramp-up before the model performs at target. Normal for
complex enterprise AI but spans multiple budget reporting cycles.

Score 2 (12-18 months): Significant organizational change or extended data
collection required before the model performs reliably. High budget-cycle risk -
the initial sponsor may no longer be in role when ROI materialises.

Score 1 (>18 months or structurally unclear): ROI requires multi-year platform
transformation or is structurally unmeasurable within a reasonable timeframe.
High deal risk - unlikely to survive a leadership change or budget reallocation.`
  },
  {
    id: "data_readiness", label: "Client Data Readiness", weight: 9, enabled: true,
    brief: "Whether target clients typically have the data this solution needs in accessible, usable form - structured or unstructured - without a multi-month data infrastructure project first",
    fullDef: `SCOPE NOTE: Data readiness applies to both structured data (ERP, CRM, EHR
records) and unstructured data (documents, emails, call recordings, images).
Unstructured data that is digitized, accessible, and legally cleared for AI
processing counts as Score 4-5 depending on volume and labeling quality.
Do not penalise unstructured sources simply because they are not in a
relational database - assess actual accessibility and usability.

Score 5 (Data ready, minimal prep): Data exists in accessible digital form -
structured systems (ERP, CRM, EHR) or well-organized unstructured stores
(document repositories, call recording archives). Legal clearance for AI
processing is standard for this vertical. Minimal data prep before model
training or RAG indexing.

Score 4 (Minor prep, 2-4 weeks): Data exists and is accessible but requires
ETL, cleansing, format normalization, or lightweight labeling. Normal project
setup work - not a delivery risk, just a scoped task.

Score 3 (Significant prep, 1-3 months): Data is partially digitized,
inconsistently structured, or requires substantial labeling or de-duplication
before AI development can begin. Adds meaningful cost and timeline to the project.

Score 2 (Major challenge, 3-6 months): Data largely in paper, legacy systems,
siloed across disconnected departments, or subject to legal constraints requiring
significant resolution work. Data preparation may cost as much as the AI build itself.

Score 1 (Data does not exist or is inaccessible): Requires IoT deployment, new
logging infrastructure, multi-year data accumulation, or regulatory clearance
not yet in place. No viable training or runtime data at most target clients.`
  },
  {
    id: "feasibility", label: "Build Feasibility", weight: 9, enabled: true,
    brief: "Technical and domain complexity of delivery for an outsourcing AI team - accounting for both engineering difficulty and domain expertise requirements",
    fullDef: `Score 5 (Straightforward): Composable with standard cloud AI services (Azure
OpenAI, AWS Bedrock, GCP Vertex AI) and open-source libraries. No proprietary
hardware, novel research, or deep domain expertise required. Team of 3-5
generalist AI engineers can deliver in 2-3 months without embedded vertical SMEs.

Score 4 (Moderate): Requires prompt engineering expertise, RAG architecture
design, or supervised fine-tuning. Evaluation framework needed. 5-8 person
team, 3-5 months. Domain knowledge is needed but acquirable through client
SME collaboration - does not require embedded vertical specialists.

Score 3 (Complex): Requires dedicated ML engineers AND either: (a) domain SMEs
embedded in the team for the full delivery - medical coding, legal contract
interpretation, financial risk modelling where errors carry liability and
publicly available training data is scarce; OR (b) custom model training,
MLOps pipelines, and a bespoke evaluation harness. 8-12 people, 6-12 months.

Score 2 (Specialist): Requires specialized hardware (edge inference, robotics,
medical-grade sensors), OT/SCADA system integration, certified development
processes (FDA software development lifecycle), or domain expertise that does
not typically exist in a generalist outsourcing team.

Score 1 (R&D-level): Novel model architecture, proprietary research platform,
or 18+ month investment required. Delivery risk is fundamental and
not addressable through project management. Not achievable without a
dedicated research function.`
  },
  {
    id: "market_size", label: "Market Size", weight: 7, enabled: true,
    brief: "Number of realistically reachable client engagements given the outsourcer's existing vertical presence - not global TAM, and weighted by deal size potential",
    fullDef: `IMPORTANT: Score against the realistically addressable market given the
outsourcer's existing vertical credibility and GTM reach - not global TAM.
10,000 potential buyers globally is irrelevant if the company has no
credibility or relationships in 9,000 of them. Also factor deal size:
200 large enterprise engagements at $1M+ is a stronger market than
5,000 SME engagements at $30k each.

Score 5 (Very large, accessible, high-value): 1,000+ reachable buyers
within existing GTM reach. Horizontal use case applicable across multiple
industries the outsourcer already serves. Large enterprise deal sizes
($500k+). Recurring engagement potential as the solution evolves.

Score 4 (Strong vertical, accessible): 300-1,000 reachable buyers in a
vertical where the outsourcer has credibility and relationships. Clear
buyer persona with dedicated AI budget lines. Deal sizes support a
repeatable practice ($200k-$1M range).

Score 3 (Clear niche, reachable): 100-300 reachable buyers with recurring
need and demonstrated willingness to commission custom delivery. Deal sizes
are viable but practice-building requires 3-5 years of consistent focus.

Score 2 (Narrow or constrained): 50-100 reachable buyers. Viable for a
focused niche strategy or a key anchor client relationship, but limited
as a standalone practice-building opportunity.

Score 1 (<50 reachable buyers or hyper-niche): Practice replication is
not realistic even after a successful first delivery. Effectively a
one-off or anchor-client-specific opportunity.`
  },
  {
    id: "build_vs_buy", label: "Build vs. Buy Pressure", weight: 9, enabled: true,
    brief: "Does a mature off-the-shelf SaaS already solve this well enough that clients license it instead of commissioning a custom project - directly determining whether a delivery opportunity exists at all",
    fullDef: `OUTSOURCING DELIVERY CONTEXT: This dimension measures whether a custom
delivery project exists at all. Score 5 = no viable SaaS, clients must
build custom. Score 1 = dominant SaaS eliminates the delivery opportunity
entirely. A score of 3 means a partial implementation opportunity exists
but with lower margin and constrained scope.

Score 5 (High custom demand): No dominant SaaS product covers this use
case adequately. Clients must commission a custom build or heavily
customize a foundation platform. The outsourcer is the natural and often
only viable path to implementation.

Score 4 (Customization always required): Products exist but none solve
the problem at enterprise scale without significant custom integration,
fine-tuning, or domain-specific extension. Outsourcer adds clear,
defensible value in every deal regardless of which platform the client
has already licensed.

Score 3 (Implementation track available): Established SaaS requires
3-6 months of implementation, configuration, and integration work.
Outsourcer can own the implementation track, though margin is lower
and the delivery scope is more constrained than a full custom build.

Score 2 (Limited integration role): 1-2 dominant platforms solve 80%+
of the problem out of the box. Outsourcer role is limited to lower-value
configuration and light integration. Deal sizes are constrained and
the client may prefer the vendor's own professional services.

Score 1 (Commodity SaaS, no project): Salesforce, ServiceNow, Microsoft
Copilot, or similar fully covers the use case. Clients self-configure
or use the vendor's professional services. No natural custom delivery
project exists.`
  },
  {
    id: "regulatory", label: "Regulatory & Compliance Risk", weight: 8, enabled: true,
    brief: "How much regulatory complexity will expand project scope, delay delivery, or expose the outsourcer to shared liability - higher score means a cleaner delivery profile, not an absence of regulation",
    fullDef: `POLARITY NOTE: Higher score = lower regulatory burden = cleaner delivery
profile. Score 5 = delivery-ready compliance environment. Score 1 =
regulatory blocker. Do not confuse "this is a regulated industry" with
"this use case scores low" - score the specific compliance burden the
AI deployment creates, not the general regulatory environment of the vertical.

Score 5 (Delivery-ready compliance profile): Standard data privacy
(GDPR, CCPA) only. No sector-specific AI approval required. Manageable
with standard enterprise DPAs and privacy controls. Outsourcer has no
unusual liability exposure.

Score 4 (Standard compliance overhead): HIPAA, SOX, or PCI compliance
required but well-understood with established delivery playbooks. Adds
2-4 weeks of compliance configuration work. Does not affect overall
delivery timeline materially.

Score 3 (Meaningful compliance workstream): EU AI Act high-risk system
classification, FCA model risk management requirements, or mandatory
audit trail and explainability requirements. Adds 1-3 months to the
delivery timeline, requires a compliance specialist embedded in the
team, and increases documentation overhead throughout.

Score 2 (Significant regulatory barrier): FDA 510(k) clearance, FCA
formal model approval, full SR 11-7 model risk compliance, or equivalent
multi-month regulatory pathway required before deployment. Process is
partly outside the delivery team's control and timelines are uncertain.

Score 1 (Regulatory blocker): Multiple overlapping frameworks (EU AI
Act + sector-specific regulation + data residency requirements).
Deployment is contingent on regulatory approval that may not materialise.
Outsourcer carries shared liability risk and the delivery timeline is
fundamentally unpredictable.`
  },
  {
    id: "change_mgmt", label: "Change Management", weight: 8, enabled: true,
    brief: "Organizational and stakeholder resistance the client faces post-build - covering both internal workforce disruption and external-facing changes - the leading cause of AI project failure in production",
    fullDef: `SCOPE NOTE: Change management risk applies to both internal disruption
(workforce role changes, process redesign) and external disruption
(customer-facing AI replacing human interactions, partner workflow changes).
Assess both dimensions where relevant. External stakeholder resistance
should be weighted similarly to internal workforce disruption - a chatbot
replacing a human customer service channel carries equivalent change risk
to an internal workflow redesign of comparable scale.

Score 5 (Minimal disruption, internal and external): Augments existing
workflows with no visible role disruption. Internal users adopt organically
with minimal training. No role elimination, union involvement, or C-suite
mandate required. External-facing changes (if any) are additive, not
replacing existing human touchpoints.

Score 4 (Moderate, contained change): Requires training and process
adjustment for one team or department internally. No role elimination.
If customer-facing, AI supplements rather than replaces human interaction.
Change is limited in scope and manageable with a standard adoption playbook.

Score 3 (Significant change program required): Redesigns workflows across
multiple teams, or replaces a significant human touchpoint externally
(a customer service channel, a partner portal, a field role). Some internal
role displacement or external experience disruption. Formal change management
program adds to scope, timeline, and cost.

Score 2 (Major transformation with political risk): Internal role elimination
at scale, union negotiation risk, or C-suite-mandated transformation program.
Or externally: AI fully replacing a high-touch human interaction where
customers or partners have strong expectations of human contact.

Score 1 (High failure risk, documented resistance): Workforce-wide
transformation with strong documented internal resistance, or customer-facing
AI replacement where comparable deployments have faced public backlash or
been rolled back. Pattern of failure in similar organizations exists in
the public record.`
  },
  {
    id: "reusability", label: "Reusability / Productization", weight: 7, enabled: true,
    brief: "Whether this solution has the structural characteristics that enable IP reuse across multiple clients - assessed on architecture signals, not speculative reuse percentages",
    fullDef: `SCORING METHOD: Assess three structural signals that predict reusability.
Do not estimate reuse percentages - these are speculative before delivery.
Score 5 requires all three signals positive. Score 3 requires two.
Score 1 means none apply.

Signal 1 - Standard integration patterns: Does this use case connect to
common enterprise systems (CRM, ERP, EHR, document stores) via standard
APIs? Or does it require bespoke integration to a proprietary or legacy
system unique to each client?

Signal 2 - Common AI task type: Is the core AI task a well-established
category (document extraction, classification, generation, summarisation,
retrieval, recommendation)? Or is it a novel AI task requiring custom
architecture per engagement?

Signal 3 - Repeatable evaluation framework: Can success be measured with
a standard eval harness (accuracy, F1, latency, coverage) that is reusable
across clients? Or does each client require a bespoke evaluation methodology
tied to their specific workflows?

Score 5 (All three signals positive): Standard integrations, common task
type, repeatable eval. Core model, prompt library, connectors, and
evaluation framework are all reusable. Second and third clients are
materially faster to deliver at higher margin. Clear proprietary IP asset.

Score 4 (Two of three signals positive): Architecture and tooling transfer
to new clients in the same vertical. One component - usually integration
or evaluation - requires per-client customization but the core is reusable.

Score 3 (One of three signals positive): Common patterns emerge after
multiple deliveries but two of three components require significant
re-engineering per client. IP accumulates slowly over 4-6 engagements.

Score 2 (No signals positive, bespoke): Unique data source, novel AI task,
and bespoke evaluation methodology. Highly client-specific. Minimal IP
accumulates across engagements.

Score 1 (No reuse, effectively staff augmentation): Every engagement is
a clean-sheet build. No productization path regardless of delivery volume.
Revenue scales only with headcount.`
  },
];
