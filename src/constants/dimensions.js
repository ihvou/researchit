export const DEFAULT_DIMS = [
  {
    id: "roi", label: "ROI Magnitude", weight: 18, enabled: true,
    brief: "Scale of verifiable financial impact  -  cost savings, revenue uplift, or loss prevention per deployment",
    fullDef: `Score 5 (>$50M per deployment or >$500M industry-wide): Audited P&L or press-release-verified outcomes. E.g. Mastercard fraud prevention ($50B/3yrs), JPMorgan LLM Suite ($1.5B stated annual value), CommonSpirit Health RCM ($100M+/yr), Aviva motor claims (GBP 60M in 2024).
Score 4 ($10M-$50M): Clear operational metrics with credible financial proxy  -  FTE redeployment, asset downtime reduction, denial-rate reduction with modeled revenue impact.
Score 3 ($1M-$10M): Real production deployments but self-reported or operational metrics only (hours saved, cycle time, FTEs avoided). No independent verification.
Score 2 (<$1M or soft metrics only): Satisfaction scores, NPS, adoption rate without financial translation. Or very early-stage deployments.
Score 1 (Unverified / projected): ROI estimated or projected only. No production deployments with measured, repeatable financial outcomes.`
  },
  {
    id: "ai_fit", label: "AI Applicability", weight: 14, enabled: true,
    brief: "How fundamentally AI-suited this problem is  -  versus traditional software, rules engines, RPA, or offshore BPO",
    fullDef: `Score 5 (Uniquely AI): Essentially unsolvable at production scale without AI. Requires real-time pattern recognition in unstructured data, language understanding, or inference across millions of daily events. 100x headcount otherwise. Examples: ambient clinical documentation, real-time fraud detection, computer vision defect inspection.
Score 4 (Strong advantage): AI provides 5-10x improvement over traditional approaches in accuracy, speed, or scale. Rules-based systems exist but degrade badly at edge cases or high volume.
Score 3 (Meaningful improvement): AI improves on traditional approaches but traditional still works acceptably  -  efficiency gain, not a fundamental new capability.
Score 2 (Marginal advantage): Traditional RPA, rule engines, or offshore BPO achieves 70%+ of the outcome at lower cost and lower delivery risk.
Score 1 (Poor fit): Problem is primarily workflow or process design. AI adds marginal value over good software engineering or process improvement. Risk of over-engineering.`
  },
  {
    id: "evidence", label: "Evidence Density", weight: 13, enabled: true,
    brief: "Number and quality of verified real-world enterprise deployments with quantified, repeatable ROI in this specific use case",
    fullDef: `Score 5 (5+ named enterprises, audited or press-verified): Peer-reviewed studies or earnings call disclosures available. Outcomes replicable across geographies and company sizes. Pattern is clearly established.
Score 4 (3-5 named companies, specific metrics): Named executives or vendor case studies with verifiable claims. Financial or strong operational metrics.
Score 3 (2-3 named companies, operational metrics): Hours saved, cycle time, FTEs  -  rather than pure financial outcomes. May be limited to specific geographies or company sizes.
Score 2 (1-2 companies, self-reported): Metrics without independent verification. May be limited to pilot or early deployment stages.
Score 1 (Anecdotal or pilot only): No production deployments with measured, repeatable outcomes. POC stage only.`
  },
  {
    id: "ttv", label: "Time to Value", weight: 11, enabled: true,
    brief: "Speed from project kick-off to client seeing measurable, reportable ROI  -  faster reduces client risk and improves deal velocity",
    fullDef: `Score 5 (60-90 days): ROI visible within one quarter. Can be demonstrated in a time-boxed pilot before full deployment commitment. Very low client risk.
Score 4 (3-6 months): Standard enterprise integration timeline. ROI measurable post go-live within a typical budget year. Manageable risk.
Score 3 (6-12 months): Full ROI requires data preparation, integration work, and change management ramp-up. Normal for complex enterprise AI.
Score 2 (12-18 months): Significant organizational change or extended data collection required before the model performs reliably. High budget-cycle risk.
Score 1 (>18 months or fundamentally unclear): ROI requires multi-year platform transformation. High deal risk  -  unlikely to survive a budget cycle or leadership change.`
  },
  {
    id: "data_readiness", label: "Client Data Readiness", weight: 9, enabled: true,
    brief: "Whether target clients typically have the data infrastructure this solution needs  -  or if data prep dominates the project budget",
    fullDef: `Score 5 (Data ready): Already digitized, structured, and accessible in standard enterprise systems (ERP, CRM, EHR). Minimal data prep before model training or RAG indexing.
Score 4 (Minor prep, 2-4 weeks): Data exists digitally but requires ETL, cleansing, or consolidation. Normal project setup work, not a risk.
Score 3 (Significant prep, 1-3 months): Data partially digitized. Historical labeling, de-duplication, or structuring required before AI development begins.
Score 2 (Major challenge, 3-6 months): Data largely in paper, legacy systems, or siloed across departments. Substantial infrastructure work required before AI layer.
Score 1 (Data doesn't exist): Requires IoT sensor deployment, new logging processes, or multi-year data accumulation. No viable training data at most target clients.`
  },
  {
    id: "feasibility", label: "Build Feasibility", weight: 9, enabled: true,
    brief: "Technical complexity for an outsourcing AI delivery team  -  without deep domain-specific R&D or specialized hardware capabilities",
    fullDef: `Score 5 (Straightforward): Composable with cloud AI services (Azure OpenAI, AWS Bedrock, GCP Vertex AI) and standard open-source libraries. No proprietary hardware or novel research required. Team of 3-5 can deliver in 2-3 months.
Score 4 (Moderate): Requires prompt engineering expertise, RAG architecture design, or supervised fine-tuning. Evaluation framework needed. 5-8 person team, 3-5 months.
Score 3 (Complex): Dedicated ML engineers AND domain SMEs required. Custom model training, MLOps pipelines, evaluation harness. 8-12 people, 6-12 months.
Score 2 (Specialist): Specialized hardware (edge inference, robotics, medical-grade sensors), OT/SCADA integration, or FDA-cleared software development required.
Score 1 (R&D-level): Novel architecture, proprietary research platform, or 18+ month investment. Not achievable without a dedicated research function.`
  },
  {
    id: "market_size", label: "Market Size", weight: 7, enabled: true,
    brief: "Total number of potential client engagements globally  -  determines pipeline ceiling for this use case",
    fullDef: `Score 5 (10,000+ potential buyers globally): Horizontal use case applicable across multiple industries  -  document processing, customer service AI, enterprise knowledge search, developer productivity.
Score 4 (1,000-10,000 buyers): Strong vertical with identifiable decision-makers and dedicated AI budget lines. Clear TAM with named buyer personas.
Score 3 (500-1,000 buyers): Clear niche with recurring need and demonstrated willingness to commission custom delivery.
Score 2 (100-500 buyers): Specialized vertical or geography-constrained opportunity. Good for a focused niche strategy.
Score 1 (<100 buyers or hyper-niche): Limited replication potential even after successful first delivery. Hard to build a repeatable practice.`
  },
  {
    id: "build_vs_buy", label: "Build vs. Buy Pressure", weight: 9, enabled: true,
    brief: "Does a mature off-the-shelf SaaS already solve this well enough that clients buy a license instead of commissioning a custom delivery project?",
    fullDef: `OUTSOURCING DELIVERY CONTEXT: Score 5 = no dominant SaaS exists, clients MUST commission custom delivery. Score 1 = dominant SaaS means no delivery project opportunity exists.

Score 5 (High custom demand): No dominant SaaS product. Clients must build or heavily customize. Outsourcer is the natural and often only path to implementation.
Score 4 (Customization always required): Products exist but none fully solve at enterprise scale without significant custom integration. Outsourcer adds clear, defensible value in every deal.
Score 3 (Implementation track available): Established SaaS requires 3-6 months of implementation and configuration work. Outsourcer can own the implementation track, though margin is lower.
Score 2 (Limited integration role): 1-2 dominant platforms solve 80%+ of the problem out of the box. Outsourcer role is limited to lower-value configuration and light integration only.
Score 1 (Commodity SaaS, no project): Salesforce, ServiceNow, Microsoft Copilot, or similar fully covers it. Clients self-configure or use the vendor's professional services. No natural custom delivery project.`
  },
  {
    id: "regulatory", label: "Regulatory & Compliance Risk", weight: 8, enabled: true,
    brief: "How much regulatory complexity will expand scope, delay delivery timeline, or create shared liability for the outsourcing team",
    fullDef: `Score 5 (Low risk): Standard data privacy (GDPR, CCPA) only. No sector-specific AI approval required. Manageable with standard enterprise privacy controls and DPAs.
Score 4 (Manageable overhead): HIPAA, SOX, or PCI compliance required but well-understood. Adds 2-4 weeks of compliance work. Outsourcer has standard playbooks for these.
Score 3 (Notable overhead): EU AI Act high-risk classification, FCA model risk requirements, or formal audit trail mandated. Adds 1-3 months and requires a compliance specialist on the team.
Score 2 (Significant barrier): FDA 510(k) clearance, FCA formal model approval, or full SR 11-7 model risk compliance pathway required. 6-18 month process outside the delivery team's control.
Score 1 (Blocking risk): Multiple overlapping regulatory frameworks (e.g. EU AI Act + sector-specific + data residency). Deployment contingent on regulatory approval that may never come. Outsourcer carries shared liability risk.`
  },
  {
    id: "change_mgmt", label: "Change Management", weight: 8, enabled: true,
    brief: "Organizational resistance and adoption complexity the client faces  -  the single leading cause of AI project failure post-build",
    fullDef: `Score 5 (Minimal disruption): Augments existing workflow with no visible role disruption. Users adopt organically with minimal training. No role elimination, union involvement, or C-suite mandate required.
Score 4 (Moderate change): Requires training and process adjustment for one team or department. No role elimination. Change limited in scope and duration  -  manageable with a standard adoption playbook.
Score 3 (Significant change): Redesigns workflows across multiple teams or business units. Some role displacement. Formal change management program is required and adds to scope, timeline, and cost.
Score 2 (Major transformation): Role elimination at scale, potential union negotiation, or C-suite-mandated change program. High political risk inside the client organization. Requires dedicated OCM workstream.
Score 1 (High failure risk): Workforce-wide transformation with strong, documented internal resistance. Similar AI deployments at comparable companies have been rolled back or failed publicly.`
  },
  {
    id: "reusability", label: "Reusability / Productization", weight: 7, enabled: true,
    brief: "Can this solution be repackaged across multiple clients  -  building IP assets that compound the outsourcer's margin on repeat engagements",
    fullDef: `Score 5 (<20% customization per repeat client): Core model, prompt library, evaluation framework, connectors, and deployment scripts are all reusable. Second and third clients are significantly faster to deliver at higher margin. Clear proprietary IP asset.
Score 4 (40-60% reuse): Architecture and tooling transfer to new clients in the same vertical. Domain-specific components are tuned per client but the heavy lifting is done.
Score 3 (30-40% reuse): Common patterns emerge after 2-3 deliveries. IP accumulates slowly but each engagement still requires significant re-engineering. Productization takes 3-4 clients.
Score 2 (Low reuse, ~20%): Highly bespoke to each client's data, processes, and integration stack. Minimal IP accumulates across engagements.
Score 1 (No reuse, staff augmentation): Every engagement is effectively a clean-sheet build. No productization path. Revenue scales only with headcount.`
  },
];
