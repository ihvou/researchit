import {
  SYS_ANALYST,
  SYS_CRITIC,
  SYS_ANALYST_RESPONSE,
  SYS_FOLLOWUP,
} from "../engine/prompts/defaults.js";

const SHARED_MODELS = {
  analyst: {
    provider: "openai",
    model: "gpt-5.4-mini",
    webSearchModel: "gpt-5.4-mini",
  },
  critic: {
    provider: "openai",
    model: "gpt-5.4",
    webSearchModel: "gpt-5.4",
  },
};

const SHARED_LIMITS = {
  maxSourcesPerDim: 14,
  discoveryMaxCandidates: 5,
  tokenLimits: {
    phase1Evidence: 10000,
    phase1Scoring: 12000,
    critic: 6000,
    phase3Response: 6000,
    followUpQuestion: 1400,
    followUpChallenge: 2100,
    intentClassification: 450,
  },
};

const BASE_PROMPTS = {
  analyst: SYS_ANALYST,
  critic: SYS_CRITIC,
  analystResponse: SYS_ANALYST_RESPONSE,
  followUp: SYS_FOLLOWUP,
};

const DEFAULT_INPUT_SPEC = {
  label: "New Research - describe what should be researched",
  placeholder: "Describe what you want to research. Broad or detailed inputs are both acceptable.",
  description: "Accept broad or detailed input. Do not infer missing specifics unless explicitly provided.",
};

const INPUT_SPEC_BY_CONFIG = {
  "startup-product-idea-validation": {
    label: "New Research - describe the startup or product idea",
    placeholder: "E.g. AI co-pilot for insurance claims adjusters in US mid-market carriers.",
    description: "Describe the startup/product idea and the problem it aims to solve. Segment and geography are optional.",
  },
  "market-entry-analysis": {
    label: "New Research - describe the market entry question",
    placeholder: "E.g. Should a US B2B payroll SaaS expand into Germany in 2026?",
    description: "Describe the offer and target market entry decision. Include geography and segment if known.",
  },
  "competitive-landscape": {
    label: "New Research - describe the category or competitor set",
    placeholder: "E.g. Competitive landscape for AI contract lifecycle management for enterprise legal teams.",
    description: "Describe the category, focal company/product, or competitive question to map advantage structure.",
  },
  "build-vs-buy-technology-decision": {
    label: "New Research - describe the build vs buy decision",
    placeholder: "E.g. Build in-house RAG stack vs buy managed platform for regulated customer support workflows.",
    description: "Describe the capability under decision and the realistic build/buy/hybrid options.",
  },
  "investment-m-and-a-screening": {
    label: "New Research - describe the investment or M&A target",
    placeholder: "E.g. Evaluate acquisition of a vertical AI coding assistant company for strategic expansion.",
    description: "Describe the target and strategic rationale. Valuation details are optional at initial pass.",
  },
  "product-expansion-new-feature-adjacent-segment-new-geography": {
    label: "New Research - describe the expansion move",
    placeholder: "E.g. Expand core SMB invoicing product into AP automation for upper-mid-market finance teams.",
    description: "Describe the current core and proposed expansion (feature, segment, or geography).",
  },
};

const DEFAULT_FRAMING_FIELDS = [
  {
    id: "researchObject",
    label: "Research Object",
    description: "What is being evaluated (idea, offer, target, capability, or expansion move).",
  },
  {
    id: "decisionQuestion",
    label: "Decision Question",
    description: "What decision this research should inform.",
  },
  {
    id: "scopeContext",
    label: "Scope / Context",
    description: "Explicit boundaries such as segment, geography, timeframe, and constraints.",
  },
];

function normalizeInputSpec(inputSpec = {}) {
  return {
    label: String(inputSpec?.label || DEFAULT_INPUT_SPEC.label).trim() || DEFAULT_INPUT_SPEC.label,
    placeholder: String(inputSpec?.placeholder || DEFAULT_INPUT_SPEC.placeholder).trim() || DEFAULT_INPUT_SPEC.placeholder,
    description: String(inputSpec?.description || DEFAULT_INPUT_SPEC.description).trim() || DEFAULT_INPUT_SPEC.description,
  };
}

function normalizeFramingFields(framingFields = []) {
  const normalized = Array.isArray(framingFields)
    ? framingFields
      .map((field, idx) => {
        const rawId = String(field?.id || "").trim();
        const fallbackId = `field_${idx + 1}`;
        const id = (rawId || fallbackId).replace(/[^a-zA-Z0-9_-]/g, "");
        return {
          id: id || fallbackId,
          label: String(field?.label || rawId || fallbackId).trim() || fallbackId,
          description: String(field?.description || "").trim(),
        };
      })
      .filter((field) => field.id)
    : [];
  return normalized.length ? normalized : DEFAULT_FRAMING_FIELDS;
}

const CONFIG_SPECS = [
  {
    "id": "startup-product-idea-validation",
    "name": "Startup / Product Idea Validation",
    "methodology": "This type of research is anchored in Jobs to Be Done and Outcome-Driven Innovation for problem selection and unmet need quality; Sequoia's Arc product-market fit framework for market, product, and customer fit; a16z's work on growth metrics and distribution moats for early evidence quality and go-to-market realism; Hamilton Helmer's *7 Powers* for whether a promising idea could ever become defensible; and Marty Cagan's *Transformed* for product discovery discipline and evidence over opinion. I weighted problem reality and demand evidence above \"idea quality,\" because current practitioner thinking treats false positives on demand as the most common early-stage decision error.",
        "relatedDiscovery": true,
    "dimensions": [
      {
        "id": "problem-severity",
        "label": "Problem Severity",
        "weight": 22,
        "enabled": true,
        "brief": "How painful, frequent, and costly the target problem is for a clearly defined user segment.",
        "fullDef": "What it measures: How painful, frequent, and costly the target problem is for a clearly defined user segment.\nWhy it matters: Teams routinely build around interesting workflows rather than painful ones, then discover the buyer tolerates the status quo.\n\nScoring rubric:\n- 5 (Strong): Multiple independent sources show the problem occurs frequently for a defined segment; active workarounds exist; users spend real time or money on the problem; at least one proxy signal exists such as job postings, search demand, communities, or budgeted tooling.\n- 4 (Good): Problem is clearly documented and recurring; workarounds are visible; pain appears material, though evidence is less quantified or less segment-specific.\n- 3 (Moderate): Problem is plausible and acknowledged, but frequency, cost, or intensity are only partially evidenced.\n- 2 (Weak): Problem is described mostly in opinion pieces, founder intuition, or broad trend language; few concrete workarounds or behavioral signals.\n- 1 (Poor): Little evidence the problem is acute; users appear satisfied with current behavior or do not meaningfully act to solve it."
      },
      {
        "id": "segment-specificity",
        "label": "Segment Specificity",
        "weight": 15,
        "enabled": true,
        "brief": "How sharply the initial customer and use case are defined.",
        "fullDef": "What it measures: How sharply the initial customer and use case are defined.\nWhy it matters: Broad categories create false confidence because demand signals and objections vary dramatically across segments.\n\nScoring rubric:\n- 5 (Strong): Initial segment is narrow and operationally clear by role, company type, trigger, and use case; evidence consistently refers to that segment.\n- 4 (Good): Segment is well defined by role or customer type, with a clear use case, though some boundary conditions remain fuzzy.\n- 3 (Moderate): Segment is partly specified but still aggregates materially different buyers or workflows.\n- 2 (Weak): Audience is broad and generic, such as \"small businesses\" or \"marketers,\" with no clear entry wedge.\n- 1 (Poor): No specific customer segment is defined beyond general market labels."
      },
      {
        "id": "demand-evidence",
        "label": "Demand Evidence",
        "weight": 18,
        "enabled": true,
        "brief": "The quality of observable signals that buyers will adopt or pay.",
        "fullDef": "What it measures: The quality of observable signals that buyers will adopt or pay.\nWhy it matters: Founders often mistake verbal interest for demand.\n\nScoring rubric:\n- 5 (Strong): Evidence includes multiple behavioral signals such as paid pilots, preorders, waitlist conversion, active budget line items, switching behavior, RFPs, or sustained organic pull.\n- 4 (Good): At least one strong behavioral signal exists plus several supporting signals such as repeated inbound requests or high-intent search/community activity.\n- 3 (Moderate): Evidence is mostly interviews, survey intent, or design-partner enthusiasm, with limited proof of real commitment.\n- 2 (Weak): Demand is inferred from market size, trend narratives, or comparable company success rather than direct buyer behavior.\n- 1 (Poor): No meaningful evidence of willingness to adopt or pay."
      },
      {
        "id": "workflow-fit-and-switching-cost",
        "label": "Workflow Fit & Switching Cost",
        "weight": 15,
        "enabled": true,
        "brief": "How naturally the product fits into the user's existing workflow and whether adoption friction is manageable.",
        "fullDef": "What it measures: How naturally the product fits into the user's existing workflow and whether adoption friction is manageable.\nWhy it matters: Many good ideas fail because they require too much behavior change relative to the perceived gain.\n\nScoring rubric:\n- 5 (Strong): Product slots into an existing high-frequency workflow; implementation burden is low; buyer can trial without major process redesign; existing alternatives create visible frustration.\n- 4 (Good): Workflow fit is credible and value is clear, but adoption requires moderate setup, retraining, or integration.\n- 3 (Moderate): Value proposition is understandable, but switching requires notable habit change or process adjustment.\n- 2 (Weak): Product requires users to learn a new workflow, maintain duplicate systems, or reorganize ownership before value appears.\n- 1 (Poor): Adoption would require major behavior change with weak immediate payoff."
      },
      {
        "id": "monetization-logic",
        "label": "Monetization Logic",
        "weight": 12,
        "enabled": true,
        "brief": "Whether there is a credible path from use to revenue with sane economics.",
        "fullDef": "What it measures: Whether there is a credible path from use to revenue with sane economics.\nWhy it matters: Teams often validate usefulness without validating a buyer, budget, or pricing mechanism.\n\nScoring rubric:\n- 5 (Strong): Clear payer exists; pricing basis matches value metric; plausible gross margin and payback logic can be inferred from public benchmarks or comparable tools.\n- 4 (Good): Buyer and pricing motion are mostly clear, though some assumptions on budget source or sales cost remain untested.\n- 3 (Moderate): Monetization is plausible but depends on uncertain packaging, unclear buyer ownership, or thin benchmark support.\n- 2 (Weak): Product seems useful, but payer, contract size, or economic model is vague.\n- 1 (Poor): No credible monetization path beyond speculative future upsell or scale."
      },
      {
        "id": "distribution-advantage",
        "label": "Distribution Advantage",
        "weight": 10,
        "enabled": true,
        "brief": "Whether the team has a credible way to reach the first customers efficiently.",
        "fullDef": "What it measures: Whether the team has a credible way to reach the first customers efficiently.\nWhy it matters: Early products often die from customer acquisition friction rather than product quality.\n\nScoring rubric:\n- 5 (Strong): There is a specific repeatable wedge such as founder access, embedded distribution, ecosystem partner, community authority, or bottom-up viral loop with evidence from analogs.\n- 4 (Good): One realistic acquisition channel stands out and appears cost-effective for the target segment.\n- 3 (Moderate): Potential channels are identifiable, but none clearly look advantaged or efficient.\n- 2 (Weak): Go-to-market assumes crowded paid acquisition, broad outbound, or \"content\" without evidence of channel fit.\n- 1 (Poor): No believable customer acquisition motion is visible."
      },
      {
        "id": "defensibility-potential",
        "label": "Defensibility Potential",
        "weight": 8,
        "enabled": true,
        "brief": "Whether the idea could plausibly develop durable advantage if it works.",
        "fullDef": "What it measures: Whether the idea could plausibly develop durable advantage if it works.\nWhy it matters: Some products solve real problems but remain too easy to copy to justify investment.\n\nScoring rubric:\n- 5 (Strong): Clear path exists to one or more durable powers such as switching costs, scale economies, workflow embedding, network effects, cornered resources, or process power.\n- 4 (Good): Early signs of defensibility exist, though compounding mechanisms are not yet proven.\n- 3 (Moderate): Product may gain temporary advantage through execution or speed, but durable moat is uncertain.\n- 2 (Weak): Advantage appears mostly feature-based and easily replicable by better-distributed incumbents.\n- 1 (Poor): No credible source of durable differentiation is visible."
      }
    ],
    "tabLabel": "Startup Validation"
  },
  {
    "id": "market-entry-analysis",
    "name": "Market Entry Analysis",
    "methodology": "This type of research is grounded in McKinsey's current \"where to play\" and market-specific competitive-advantage work, especially its emphasis that advantage is context-specific at the intersection of offering, geography, and customer; BCG's strategy and sector work on uneven market conditions and local fit; Bain's strategic-fit logic; and classic strategy books that remain widely used in practice, especially Rumelt on diagnosis and coherent action. The result is not a generic \"country attractiveness\" template: it is a right-to-win test for a specific offer in a specific market.",
        "relatedDiscovery": true,
    "dimensions": [
      {
        "id": "market-attractiveness",
        "label": "Market Attractiveness",
        "weight": 20,
        "enabled": true,
        "brief": "The size, growth, profit pool, and structural momentum of the target market.",
        "fullDef": "What it measures: The size, growth, profit pool, and structural momentum of the target market.\nWhy it matters: Teams often enter large but unattractive markets with weak margins or slowing demand.\n\nScoring rubric:\n- 5 (Strong): Credible sources show large and growing demand, healthy margins or spend intensity, and tailwinds that support multi-year entry economics.\n- 4 (Good): Market is clearly attractive on size and growth, though profit pool or demand durability is less certain.\n- 3 (Moderate): Market has either scale or growth, but not both clearly; attractiveness depends on assumptions.\n- 2 (Weak): Market is small, slowing, margin-thin, or structurally difficult despite headline size.\n- 1 (Poor): Market is unattractive on both scale and economics."
      },
      {
        "id": "local-need-fit",
        "label": "Local Need Fit",
        "weight": 18,
        "enabled": true,
        "brief": "How well the offer matches local customer needs, buying criteria, and usage conditions.",
        "fullDef": "What it measures: How well the offer matches local customer needs, buying criteria, and usage conditions.\nWhy it matters: Companies over-extrapolate from success in one market to another.\n\nScoring rubric:\n- 5 (Strong): Local customer needs, purchasing criteria, and product requirements are well evidenced and closely match the proposed offer with minimal adaptation.\n- 4 (Good): Core value proposition appears to translate, but some feature, pricing, or service localization is needed.\n- 3 (Moderate): Need fit is plausible but partially inferred from adjacent markets or broad similarities.\n- 2 (Weak): Significant adaptation appears necessary across product, pricing, or support.\n- 1 (Poor): The offer does not clearly solve a locally valued problem."
      },
      {
        "id": "competitive-right-to-win",
        "label": "Competitive Right-to-Win",
        "weight": 18,
        "enabled": true,
        "brief": "Whether the entrant has a real basis to win against incumbents and substitutes.",
        "fullDef": "What it measures: Whether the entrant has a real basis to win against incumbents and substitutes.\nWhy it matters: Market entry fails when firms choose attractive markets where they lack a nontrivial advantage.\n\nScoring rubric:\n- 5 (Strong): Entrant has a differentiated asset or model that local competitors would struggle to match, and that difference matters to buyers.\n- 4 (Good): Entrant has a credible edge on product, cost, channel, brand, or partner access, though incumbent response remains possible.\n- 3 (Moderate): Entrant could compete, but advantage is narrow or not yet proven locally.\n- 2 (Weak): Entry case relies mostly on being \"better\" without clear buyer-visible differentiation.\n- 1 (Poor): No clear right-to-win versus local incumbents or substitutes."
      },
      {
        "id": "route-to-market-feasibility",
        "label": "Route-to-Market Feasibility",
        "weight": 15,
        "enabled": true,
        "brief": "The practicality of acquiring customers and serving them in the target market.",
        "fullDef": "What it measures: The practicality of acquiring customers and serving them in the target market.\nWhy it matters: Strong products fail in new markets because channel, trust, and local sales motion are wrong.\n\nScoring rubric:\n- 5 (Strong): Clear acquisition path exists through proven channels, local partners, existing accounts, or embedded distribution with evidence of feasibility.\n- 4 (Good): Channel strategy is credible and resourced, though conversion assumptions are partly untested.\n- 3 (Moderate): Several channels are possible, but none clearly stand out as efficient.\n- 2 (Weak): Go-to-market depends on expensive awareness building or weak local access.\n- 1 (Poor): No realistic distribution or sales motion is identified."
      },
      {
        "id": "regulatory-and-operating-friction",
        "label": "Regulatory & Operating Friction",
        "weight": 14,
        "enabled": true,
        "brief": "The burden from regulation, compliance, localization, and execution complexity.",
        "fullDef": "What it measures: The burden from regulation, compliance, localization, and execution complexity.\nWhy it matters: Entry cases often underprice operating friction and time to readiness.\n\nScoring rubric:\n- 5 (Strong): Regulatory requirements are clear and manageable; operating model can support local needs without major redesign.\n- 4 (Good): Some compliance or localization work is needed, but effort is bounded and well understood.\n- 3 (Moderate): Material friction exists, but can likely be managed with investment.\n- 2 (Weak): Regulatory, tax, labor, or service complexity materially threatens timing or margins.\n- 1 (Poor): Friction is severe enough to undermine the entry case."
      },
      {
        "id": "entry-economics",
        "label": "Entry Economics",
        "weight": 15,
        "enabled": true,
        "brief": "Expected payback, gross margin, CAC-to-LTV logic, and investment required to establish presence.",
        "fullDef": "What it measures: Expected payback, gross margin, CAC-to-LTV logic, and investment required to establish presence.\nWhy it matters: Attractive markets still destroy value when entry costs and ramp time are underestimated.\n\nScoring rubric:\n- 5 (Strong): Entry investment, ramp assumptions, and unit economics support a credible payback case under conservative scenarios.\n- 4 (Good): Economics look favorable, though one or two assumptions remain sensitivity points.\n- 3 (Moderate): Economics are plausible but depend on optimistic adoption, pricing, or efficiency assumptions.\n- 2 (Weak): Payback appears long or fragile; economics worsen materially under moderate downside cases.\n- 1 (Poor): Entry is unlikely to create value on realistic assumptions."
      }
    ],
    "tabLabel": "Market Entry"
  },
  {
    "id": "competitive-landscape",
    "name": "Competitive Landscape",
    "methodology": "This type of research draws on Helmer's durable-advantage lens, McKinsey's granular competitive-advantage approach, and practitioner venture thinking from a16z and Sequoia that focuses less on feature comparison and more on what actually drives customer choice, market power, and white space. I excluded generic checklist competitor matrices as the scoring backbone; the point here is to understand the structure of advantage, not just list vendors.",
        "relatedDiscovery": false,
    "dimensions": [
      {
        "id": "category-structure",
        "label": "Category Structure",
        "weight": 18,
        "enabled": true,
        "brief": "Whether the market is fragmented, concentrated, bundled, rapidly consolidating, or still unsettled.",
        "fullDef": "What it measures: Whether the market is fragmented, concentrated, bundled, rapidly consolidating, or still unsettled.\nWhy it matters: Misreading category structure leads to bad assumptions about pricing power and entry difficulty.\n\nScoring rubric:\n- 5 (Strong): Landscape structure is clearly mapped with identifiable leaders, challengers, substitutes, and basis of competition.\n- 4 (Good): Major players and structure are clear, though some adjacent substitutes or emerging entrants remain less mapped.\n- 3 (Moderate): Primary competitors are known, but category boundaries and substitute set are incomplete.\n- 2 (Weak): Analysis focuses on obvious named players only.\n- 1 (Poor): No coherent view of the category or substitute landscape."
      },
      {
        "id": "customer-choice-drivers",
        "label": "Customer Choice Drivers",
        "weight": 18,
        "enabled": true,
        "brief": "The attributes that actually determine customer selection and retention.",
        "fullDef": "What it measures: The attributes that actually determine customer selection and retention.\nWhy it matters: Teams often benchmark flashy features instead of the factors buyers truly value.\n\nScoring rubric:\n- 5 (Strong): Multiple sources show clear buyer decision criteria and trade-offs, with evidence from reviews, win-loss signals, case studies, or practitioner commentary.\n- 4 (Good): Decision criteria are mostly clear, though some segments may value different things.\n- 3 (Moderate): Several plausible criteria are identified, but relative importance is not well evidenced.\n- 2 (Weak): Criteria are inferred from vendor messaging more than customer evidence.\n- 1 (Poor): No clear view of what drives customer choice."
      },
      {
        "id": "competitor-advantage-quality",
        "label": "Competitor Advantage Quality",
        "weight": 18,
        "enabled": true,
        "brief": "Whether leading competitors have real durable advantages or only temporary feature leads.",
        "fullDef": "What it measures: Whether leading competitors have real durable advantages or only temporary feature leads.\nWhy it matters: Underestimating incumbent power is a classic strategy error.\n\nScoring rubric:\n- 5 (Strong): Leading competitors show durable powers such as switching costs, ecosystem control, scale economics, proprietary distribution, network effects, or embedded workflow ownership.\n- 4 (Good): Several competitors have meaningful but not impregnable advantages.\n- 3 (Moderate): Advantages exist but look mixed, local, or vulnerable to change.\n- 2 (Weak): Claimed moats appear mostly branding or feature breadth without clear compounding mechanisms.\n- 1 (Poor): No strong competitor advantage is evident."
      },
      {
        "id": "white-space-quality",
        "label": "White-Space Quality",
        "weight": 16,
        "enabled": true,
        "brief": "Whether meaningful unmet needs or underserved segments remain open.",
        "fullDef": "What it measures: Whether meaningful unmet needs or underserved segments remain open.\nWhy it matters: Not all gaps are worth pursuing; many are too small or structurally unattractive.\n\nScoring rubric:\n- 5 (Strong): Specific unmet needs or segments are repeatedly visible, with evidence that existing tools underperform and buyers care.\n- 4 (Good): Plausible gaps exist, though evidence on monetization or segment size is thinner.\n- 3 (Moderate): Some whitespace is visible, but could simply reflect low demand.\n- 2 (Weak): Gaps look cosmetic, tiny, or already being addressed by multiple entrants.\n- 1 (Poor): No credible whitespace is visible."
      },
      {
        "id": "pace-of-change",
        "label": "Pace of Change",
        "weight": 12,
        "enabled": true,
        "brief": "How quickly the landscape is shifting through technology, regulation, bundling, or buyer behavior.",
        "fullDef": "What it measures: How quickly the landscape is shifting through technology, regulation, bundling, or buyer behavior.\nWhy it matters: Static snapshots become misleading fast in fast-moving categories.\n\nScoring rubric:\n- 5 (Strong): Clear evidence shows rapid shifts in product architecture, pricing, distribution, or buyer expectations; today's leaders may not map cleanly to tomorrow's.\n- 4 (Good): Category is evolving materially, though main competitive frame still holds.\n- 3 (Moderate): Change is present but not enough to overturn current structure soon.\n- 2 (Weak): Category is relatively stable and slow moving.\n- 1 (Poor): No meaningful competitive change is visible."
      },
      {
        "id": "relative-positioning-risk",
        "label": "Relative Positioning Risk",
        "weight": 18,
        "enabled": true,
        "brief": "How exposed the focal company or idea is relative to current competitors.",
        "fullDef": "What it measures: How exposed the focal company or idea is relative to current competitors.\nWhy it matters: A landscape map is useless if it does not translate into specific strategic risk.\n\nScoring rubric:\n- 5 (Strong): Focal position is clear, differentiated, and defensible against the most relevant competitors and substitutes.\n- 4 (Good): Position is credible, though one or two competitor responses could weaken it.\n- 3 (Moderate): Position is plausible but overlaps substantially with existing offerings.\n- 2 (Weak): Focal offer is hard to distinguish or easy for incumbents to neutralize.\n- 1 (Poor): Focal offer is undifferentiated and strategically exposed."
      }
    ],
    "tabLabel": "Competitive Landscape"
  },
  {
    "id": "build-vs-buy-technology-decision",
    "name": "Build vs. Buy / Technology Decision",
    "methodology": "This type of research uses BCG's current buy-and-build logic, which explicitly favors hybrid approaches when companies need both speed and differentiation; McKinsey's recent framing that build-versus-buy should be evaluated in light of competitive advantage and strategic flexibility; Bain's execution-first view that capabilities should be sequenced to deliver value while building lasting internal strengths; and SVPG's product-operating-model view that capabilities matter only when they materially affect product outcomes. This is why the config gives high weight to strategic criticality and time-to-value instead of treating the choice as a pure cost comparison.",
        "relatedDiscovery": true,
    "dimensions": [
      {
        "id": "strategic-criticality",
        "label": "Strategic Criticality",
        "weight": 22,
        "enabled": true,
        "brief": "Whether the capability is core to competitive advantage or merely enabling infrastructure.",
        "fullDef": "What it measures: Whether the capability is core to competitive advantage or merely enabling infrastructure.\nWhy it matters: Firms overspend building commodity capabilities and underspend owning the few things that should differentiate them.\n\nScoring rubric:\n- 5 (Strong): Capability directly shapes customer value, margin structure, control of data/workflow, or long-term moat.\n- 4 (Good): Capability is important to strategic performance, though not the sole differentiator.\n- 3 (Moderate): Capability matters operationally but does not obviously define competitive advantage.\n- 2 (Weak): Capability is mostly supporting infrastructure.\n- 1 (Poor): Capability is commodity and not strategically distinctive."
      },
      {
        "id": "time-to-value",
        "label": "Time-to-Value",
        "weight": 18,
        "enabled": true,
        "brief": "How quickly the organization can capture usable value under each path.",
        "fullDef": "What it measures: How quickly the organization can capture usable value under each path.\nWhy it matters: Build decisions often look elegant but miss the market window.\n\nScoring rubric:\n- 5 (Strong): One path clearly delivers production value quickly with limited dependency risk and realistic implementation timing.\n- 4 (Good): Value can be achieved within an acceptable window, though some dependencies remain.\n- 3 (Moderate): Time-to-value is acceptable but uncertain.\n- 2 (Weak): Delivery timing is long or heavily contingent on prerequisites.\n- 1 (Poor): Value is unlikely to arrive in time to matter."
      },
      {
        "id": "differentiation-need",
        "label": "Differentiation Need",
        "weight": 18,
        "enabled": true,
        "brief": "How much custom behavior, proprietary workflow, or unique IP is required.",
        "fullDef": "What it measures: How much custom behavior, proprietary workflow, or unique IP is required.\nWhy it matters: Buying the wrong thing can flatten differentiation; building the wrong thing wastes resources.\n\nScoring rubric:\n- 5 (Strong): Success requires substantial customization, proprietary logic, or close fit to distinctive workflows.\n- 4 (Good): Some important differentiation is needed, but a commercial base with custom layers could work.\n- 3 (Moderate): Moderate tailoring is useful but not decisive.\n- 2 (Weak): Standard solutions likely satisfy most needs.\n- 1 (Poor): Little to no differentiation is required."
      },
      {
        "id": "integration-and-change-burden",
        "label": "Integration & Change Burden",
        "weight": 16,
        "enabled": true,
        "brief": "The technical, process, and organizational effort needed to deploy and sustain the solution.",
        "fullDef": "What it measures: The technical, process, and organizational effort needed to deploy and sustain the solution.\nWhy it matters: Hidden integration and adoption costs often dominate headline licensing or build costs.\n\nScoring rubric:\n- 5 (Strong): Integration path is clear; required process change is manageable; dependencies are bounded.\n- 4 (Good): Some complexity exists, but architecture and ownership are mostly understood.\n- 3 (Moderate): Integration is feasible but touches several systems or teams.\n- 2 (Weak): Significant legacy, data, or process complexity threatens execution.\n- 1 (Poor): Integration and change burden likely swamp expected value."
      },
      {
        "id": "vendor-lock-in-risk",
        "label": "Vendor / Lock-In Risk",
        "weight": 14,
        "enabled": true,
        "brief": "Exposure to vendor dependency, roadmap misalignment, switching cost, and commercial leverage.",
        "fullDef": "What it measures: Exposure to vendor dependency, roadmap misalignment, switching cost, and commercial leverage.\nWhy it matters: \"Buy\" can solve near-term speed while creating strategic rigidity.\n\nScoring rubric:\n- 5 (Strong): Vendor risk is low, with strong interoperability, contract clarity, and acceptable switching paths.\n- 4 (Good): Some dependency exists, but can be managed contractually or architecturally.\n- 3 (Moderate): Lock-in risk is material but tolerable relative to value.\n- 2 (Weak): Vendor controls critical data, workflow, or economics in ways that could constrain the business.\n- 1 (Poor): Dependency risk is strategically unacceptable."
      },
      {
        "id": "internal-capability-readiness",
        "label": "Internal Capability Readiness",
        "weight": 12,
        "enabled": true,
        "brief": "Whether the organization can successfully build, integrate, and evolve the capability.",
        "fullDef": "What it measures: Whether the organization can successfully build, integrate, and evolve the capability.\nWhy it matters: Many build decisions are really aspiration decisions unsupported by talent and operating model.\n\nScoring rubric:\n- 5 (Strong): Team has relevant talent, product ownership, architecture, and delivery track record.\n- 4 (Good): Capability gaps are modest and realistically fillable.\n- 3 (Moderate): Build path is possible but depends on hiring, new governance, or major learning.\n- 2 (Weak): Organization lacks key talent or product/engineering maturity.\n- 1 (Poor): Internal readiness is far below what the build path requires."
      }
    ],
    "tabLabel": "Build vs Buy"
  },
  {
    "id": "investment-m-and-a-screening",
    "name": "Investment / M&A Screening",
    "methodology": "This type of research combines current M&A practice from McKinsey, BCG, and Bain with venture-style quality filters from Sequoia and a16z. The consulting side contributes strategic fit, synergy logic, diligence beyond the standard legal-financial checklist, and repeated emphasis on experienced acquirers, value creation, and deeper diligence. The venture side contributes market quality, growth quality, and defensibility. I deliberately weight quality of advantage and value-creation logic above raw market excitement because practitioners are trying to avoid expensive false positives, not just find \"interesting\" assets.",
        "relatedDiscovery": true,
    "dimensions": [
      {
        "id": "strategic-fit",
        "label": "Strategic Fit",
        "weight": 20,
        "enabled": true,
        "brief": "How well the target advances the acquirer's or investor's explicit strategy.",
        "fullDef": "What it measures: How well the target advances the acquirer's or investor's explicit strategy.\nWhy it matters: Deals fail when the asset is attractive in isolation but not useful in portfolio context.\n\nScoring rubric:\n- 5 (Strong): Target clearly strengthens a named strategic priority such as capability, market access, product line, or defensible adjacency.\n- 4 (Good): Fit is credible and specific, though multiple strategic narratives remain possible.\n- 3 (Moderate): Fit exists, but is broad or partly opportunistic.\n- 2 (Weak): Strategic rationale is vague, mostly financial, or post hoc.\n- 1 (Poor): No coherent strategic fit is visible."
      },
      {
        "id": "market-quality",
        "label": "Market Quality",
        "weight": 15,
        "enabled": true,
        "brief": "The attractiveness of the market or category the target serves.",
        "fullDef": "What it measures: The attractiveness of the market or category the target serves.\nWhy it matters: Even good assets struggle in structurally bad markets.\n\nScoring rubric:\n- 5 (Strong): Market shows strong demand, healthy economics, and favorable medium-term structure.\n- 4 (Good): Market quality is positive overall, with some manageable risks.\n- 3 (Moderate): Market is acceptable but mixed on growth, margins, or stability.\n- 2 (Weak): Market quality is weak or deteriorating.\n- 1 (Poor): Target is exposed to structurally unattractive markets."
      },
      {
        "id": "quality-of-advantage",
        "label": "Quality of Advantage",
        "weight": 18,
        "enabled": true,
        "brief": "Whether the target has durable competitive advantage rather than temporary momentum.",
        "fullDef": "What it measures: Whether the target has durable competitive advantage rather than temporary momentum.\nWhy it matters: Buyers and investors overpay for growth that is not protected.\n\nScoring rubric:\n- 5 (Strong): Target has clear durable powers visible in customer behavior, economics, or market structure.\n- 4 (Good): Advantage is real but not fully hardened.\n- 3 (Moderate): Target has strengths, but durability is uncertain.\n- 2 (Weak): Performance appears driven by execution bursts, temporary market conditions, or marketing.\n- 1 (Poor): No durable advantage is evident."
      },
      {
        "id": "value-creation-levers",
        "label": "Value-Creation Levers",
        "weight": 17,
        "enabled": true,
        "brief": "The number, quality, and plausibility of specific levers that can increase value after the deal.",
        "fullDef": "What it measures: The number, quality, and plausibility of specific levers that can increase value after the deal.\nWhy it matters: Deals disappoint when value creation is vague or relies on one fragile synergy story.\n\nScoring rubric:\n- 5 (Strong): Multiple concrete levers exist, such as cross-sell, pricing, channel leverage, cost takeout, product integration, or capability transfer, each with visible evidence.\n- 4 (Good): At least one major and one secondary lever look credible.\n- 3 (Moderate): Value creation is plausible but concentrated in a narrow set of assumptions.\n- 2 (Weak): Levers are generic or difficult to operationalize.\n- 1 (Poor): No credible post-deal value creation case is visible."
      },
      {
        "id": "execution-and-integration-risk",
        "label": "Execution & Integration Risk",
        "weight": 15,
        "enabled": true,
        "brief": "The difficulty of integrating the asset and realizing value.",
        "fullDef": "What it measures: The difficulty of integrating the asset and realizing value.\nWhy it matters: Many deals are strategically sound and still fail in execution.\n\nScoring rubric:\n- 5 (Strong): Integration scope is clear; talent, systems, culture, and regulatory risks appear manageable.\n- 4 (Good): Some integration risk exists, but no obvious deal-breaker is visible.\n- 3 (Moderate): Risks are meaningful and require disciplined execution.\n- 2 (Weak): Integration is likely to be slow, politically difficult, or operationally disruptive.\n- 1 (Poor): Realization risk is severe enough to threaten the thesis."
      },
      {
        "id": "deal-economics",
        "label": "Deal Economics",
        "weight": 15,
        "enabled": true,
        "brief": "Whether price, capital needs, and downside protection support an attractive risk-adjusted return.",
        "fullDef": "What it measures: Whether price, capital needs, and downside protection support an attractive risk-adjusted return.\nWhy it matters: Good assets become bad deals at the wrong price.\n\nScoring rubric:\n- 5 (Strong): Valuation is supported by public comps or deal logic, downside is bounded, and return case does not rely on heroic assumptions.\n- 4 (Good): Economics are reasonable, though one or two assumptions do real work.\n- 3 (Moderate): Deal could work, but return case is sensitive to growth, synergy, or exit assumptions.\n- 2 (Weak): Price or capital requirements leave little room for execution misses.\n- 1 (Poor): Economics are unattractive on realistic assumptions."
      }
    ],
    "tabLabel": "Investment / M&A"
  },
  {
    "id": "product-expansion-new-feature-adjacent-segment-new-geography",
    "name": "Product Expansion (new feature, adjacent segment, new geography)",
    "methodology": "This type of research is based on McKinsey's current work on growing within and beyond the core, Bain's long-running but still practitioner-relevant adjacency and \"beyond the core\" logic, Sequoia's product-market-fit framing, and a16z's growth thinking around expansion metrics and land-and-expand behavior. I treat expansion as a transfer test: can the company carry real advantage from the core into a new feature, segment, or geography without destroying focus or economics?",
        "relatedDiscovery": true,
    "dimensions": [
      {
        "id": "core-strength-transferability",
        "label": "Core Strength Transferability",
        "weight": 22,
        "enabled": true,
        "brief": "Whether the company's existing advantage actually carries into the expansion.",
        "fullDef": "What it measures: Whether the company's existing advantage actually carries into the expansion.\nWhy it matters: Companies confuse adjacent demand with adjacent right-to-win.\n\nScoring rubric:\n- 5 (Strong): Existing assets such as brand, data, distribution, customer relationships, workflow position, or capabilities clearly transfer into the new move.\n- 4 (Good): Several core strengths transfer, though some must be adapted.\n- 3 (Moderate): Transferability is plausible but limited.\n- 2 (Weak): Expansion relies mostly on building new capabilities from scratch.\n- 1 (Poor): Little of the current advantage meaningfully transfers."
      },
      {
        "id": "adjacency-attractiveness",
        "label": "Adjacency Attractiveness",
        "weight": 18,
        "enabled": true,
        "brief": "The size, growth, and economic quality of the new feature area, segment, or geography.",
        "fullDef": "What it measures: The size, growth, and economic quality of the new feature area, segment, or geography.\nWhy it matters: Firms often expand into adjacent spaces that look logical but are not attractive enough.\n\nScoring rubric:\n- 5 (Strong): Adjacency has meaningful size or strategic value, favorable growth, and credible economics.\n- 4 (Good): Attractive overall, though one dimension such as margin or scale is less compelling.\n- 3 (Moderate): Adjacency is viable but not clearly high quality.\n- 2 (Weak): Opportunity is niche, low-margin, or structurally difficult.\n- 1 (Poor): Adjacency is unattractive despite seeming nearby."
      },
      {
        "id": "customer-pull-and-cross-sell-evidence",
        "label": "Customer Pull & Cross-Sell Evidence",
        "weight": 16,
        "enabled": true,
        "brief": "Whether existing or target customers are actually asking for the expansion.",
        "fullDef": "What it measures: Whether existing or target customers are actually asking for the expansion.\nWhy it matters: Internal adjacency logic often substitutes for market demand.\n\nScoring rubric:\n- 5 (Strong): Repeated customer requests, expansion usage patterns, upsell behavior, or win-loss evidence show real pull.\n- 4 (Good): Strong anecdotal and some behavioral evidence support demand.\n- 3 (Moderate): Demand is plausible but only partially evidenced.\n- 2 (Weak): Expansion is justified mainly by strategy narratives rather than customer behavior.\n- 1 (Poor): Little evidence customers want the expansion."
      },
      {
        "id": "channel-and-operational-readiness",
        "label": "Channel & Operational Readiness",
        "weight": 14,
        "enabled": true,
        "brief": "Whether the organization can sell, deliver, and support the expansion without major breakdowns.",
        "fullDef": "What it measures: Whether the organization can sell, deliver, and support the expansion without major breakdowns.\nWhy it matters: Expansion often fails in execution long before strategy is tested.\n\nScoring rubric:\n- 5 (Strong): Sales motion, onboarding, support, and operational ownership are clear and largely reusable from the core.\n- 4 (Good): Some changes are needed, but operational path is manageable.\n- 3 (Moderate): Readiness is mixed and depends on new hires, partners, or process redesign.\n- 2 (Weak): Expansion requires substantially new channel or operating capabilities.\n- 1 (Poor): Organization is not operationally ready."
      },
      {
        "id": "cannibalization-and-complexity-risk",
        "label": "Cannibalization & Complexity Risk",
        "weight": 14,
        "enabled": true,
        "brief": "The risk that expansion adds confusion, cost, or internal conflict faster than value.",
        "fullDef": "What it measures: The risk that expansion adds confusion, cost, or internal conflict faster than value.\nWhy it matters: Expansion can weaken the core through product sprawl and organizational drag.\n\nScoring rubric:\n- 5 (Strong): Limited cannibalization; complexity is controlled; governance and scope are clear.\n- 4 (Good): Some overlap or complexity exists but appears manageable.\n- 3 (Moderate): Trade-offs are real and require disciplined prioritization.\n- 2 (Weak): Expansion risks confusing positioning, bloating roadmap, or straining teams.\n- 1 (Poor): Complexity or cannibalization likely outweighs upside."
      },
      {
        "id": "economic-upside",
        "label": "Economic Upside",
        "weight": 16,
        "enabled": true,
        "brief": "Whether the expansion can create meaningful incremental revenue, margin, or strategic leverage.",
        "fullDef": "What it measures: Whether the expansion can create meaningful incremental revenue, margin, or strategic leverage.\nWhy it matters: Many expansions consume focus without moving company economics.\n\nScoring rubric:\n- 5 (Strong): Expansion can materially improve revenue, retention, wallet share, margin, or strategic control on realistic assumptions.\n- 4 (Good): Economic upside is clearly positive, though not transformative.\n- 3 (Moderate): Upside exists but is modest or scenario-sensitive.\n- 2 (Weak): Incremental upside is limited relative to required investment.\n- 1 (Poor): Expansion has weak economic payoff."
      }
    ],
    "tabLabel": "Product Expansion"
  }
];

export const RESEARCH_CONFIGS = CONFIG_SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  tabLabel: spec.tabLabel || spec.name,
  engineVersion: "1.0.0",
  inputSpec: normalizeInputSpec(spec.inputSpec || INPUT_SPEC_BY_CONFIG[spec.id] || {}),
  framingFields: normalizeFramingFields(spec.framingFields || DEFAULT_FRAMING_FIELDS),
  dimensions: spec.dimensions,
  relatedDiscovery: spec.relatedDiscovery !== false,
  methodology: spec.methodology || "",
  prompts: BASE_PROMPTS,
  models: SHARED_MODELS,
  limits: SHARED_LIMITS,
}));

export const DEFAULT_RESEARCH_CONFIG = RESEARCH_CONFIGS[0];

export default DEFAULT_RESEARCH_CONFIG;
