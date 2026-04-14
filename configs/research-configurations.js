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
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    webSearchModel: "claude-sonnet-4-20250514",
  },
  retrieval: {
    provider: "gemini",
    model: "gemini-2.5-flash",
    webSearchModel: "gemini-2.5-flash",
  },
};

const SHARED_DEEP_ASSIST = {
  defaults: {
    providers: ["chatgpt", "claude", "gemini"],
    minProviders: 2,
    maxWaitMs: 300000,
    maxRetries: 1,
  },
  providers: {
    chatgpt: {
      analyst: {
        provider: "openai",
        model: "gpt-5.4",
        webSearchModel: "gpt-5.4",
      },
    },
    claude: {
      analyst: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        webSearchModel: "claude-sonnet-4-20250514",
      },
    },
    gemini: {
      analyst: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        webSearchModel: "gemini-2.5-pro",
      },
    },
  },
};

const SHARED_LIMITS = {
  maxSourcesPerDim: 14,
  discoveryMaxCandidates: 5,
  matrixCoverageSLA: {
    minSourcesPerCell: 2,
    minSubjectEvidenceCoverage: 0.5,
    maxUnresolvedCellsRatio: 0.35,
  },
  criticFlagMonitoring: {
    minAuditedCells: 8,
    minFlagRate: 0.1,
    highLowConfidenceRate: 0.3,
  },
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
  "market-sizing-tam-sam-som": {
    label: "New Research - describe the market and sizing hypothesis",
    placeholder: "E.g. Market sizing for AI copilot for US mid-market insurance claims operations.",
    description: "Describe the target problem/offer and initial market boundaries for TAM/SAM/SOM evaluation.",
  },
  "channel-gtm-analysis-scorecard": {
    label: "New Research - describe your GTM strategy hypothesis",
    placeholder: "E.g. Sales-led motion to enterprise IT directors via partner ecosystem in DACH.",
    description: "Describe the proposed GTM strategy you want to pressure-test end-to-end.",
  },
  "icp-customer-persona-matrix": {
    label: "New Research - define the ICP/persona question",
    placeholder: "E.g. Compare which initial customer segment is the strongest wedge for an AI legal assistant.",
    description: "Describe what decision this persona comparison should inform.",
  },
  "competitors-comparison-matrix": {
    label: "New Research - define the competitive comparison question",
    placeholder: "E.g. Compare top competitors for AI contract lifecycle management in enterprise legal.",
    description: "Describe what competitive decision this comparison should support.",
  },
  "channel-gtm-analysis-matrix": {
    label: "New Research - define the channel comparison question",
    placeholder: "E.g. Compare SEO, outbound, and community-led motions for early traction.",
    description: "Describe what channel prioritization decision this matrix should support.",
  },
};

const DECISION_HINTS_BY_CONFIG = {
  "startup-product-idea-validation": [
    "Go / no-go on this idea",
    "Decide what to validate first",
    "Identify highest-risk assumptions before build",
  ],
  "market-entry-analysis": [
    "Decide whether to enter this market now",
    "Choose entry wedge and sequencing",
    "Prioritize GTM motion for first traction",
  ],
  "competitive-landscape": [
    "Pick the strongest competitor to beat first",
    "Define positioning gap to exploit",
    "Prioritize differentiators for next 2 quarters",
  ],
  "build-vs-buy-technology-decision": [
    "Choose build vs buy vs hybrid",
    "Decide under timeline and budget constraints",
    "Identify lock-in and delivery risk tradeoffs",
  ],
  "investment-m-and-a-screening": [
    "Prioritize targets for deeper diligence",
    "Filter out weak-fit opportunities early",
    "Decide what evidence must be validated next",
  ],
  "product-expansion-new-feature-adjacent-segment-new-geography": [
    "Choose expansion path with best risk/reward",
    "Prioritize feature vs segment vs geography",
    "Decide what to pilot first",
  ],
  "market-sizing-tam-sam-som": [
    "Validate if opportunity is large enough now",
    "Choose realistic near-term serviceable segment",
    "Set evidence-backed growth expectations",
  ],
  "icp-customer-persona-matrix": [
    "Prioritize which ICP to target first",
    "Identify best-fit buyer profile for GTM",
    "Decide where sales effort should concentrate",
  ],
  "competitors-comparison-matrix": [
    "Choose the best competitor benchmark set",
    "Identify strongest alternatives buyers compare against",
    "Decide where current concept has clear gaps",
  ],
  "channel-gtm-analysis-scorecard": [
    "Choose primary growth channel for next quarter",
    "Prioritize channel mix under budget limits",
    "Decide what to test first for CAC efficiency",
  ],
  "channel-gtm-analysis-matrix": [
    "Compare channels to prioritize near-term execution",
    "Select channel portfolio for current constraints",
    "Decide where to allocate first GTM budget",
  ],
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

const URL_SLUG_BY_CONFIG = {
  "startup-product-idea-validation": "startup-validation",
  "market-entry-analysis": "market-entry",
  "competitive-landscape": "competitive-landscape",
  "build-vs-buy-technology-decision": "build-vs-buy",
  "investment-m-and-a-screening": "investment-m-a-screening",
  "product-expansion-new-feature-adjacent-segment-new-geography": "product-expansion",
  "market-sizing-tam-sam-som": "market-sizing",
  "icp-customer-persona-matrix": "icp-customer-persona",
  "competitors-comparison-matrix": "competitors-comparison",
  "channel-gtm-analysis-scorecard": "gtm-strategy",
  "channel-gtm-analysis-matrix": "gtm-channels-comparison",
};

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

function normalizeResearchHints(hints = null) {
  if (!hints || typeof hints !== "object") return null;
  const whereToLook = Array.isArray(hints.whereToLook)
    ? hints.whereToLook.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const queryTemplates = Array.isArray(hints.queryTemplates)
    ? hints.queryTemplates.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  if (!whereToLook.length && !queryTemplates.length) return null;
  return { whereToLook, queryTemplates };
}

function deriveShortDescription(text) {
  const raw = String(text || "").trim();
  if (!raw) return "Evidence-first research workflow with analyst and critic review.";
  const firstSentence = raw.split(/(?<=[.!?])\s+/)[0] || raw;
  if (firstSentence.length <= 190) return firstSentence;
  return `${firstSentence.slice(0, 187).trimEnd()}...`;
}

function normalizeOutputMode(value) {
  return String(value || "").trim().toLowerCase() === "matrix" ? "matrix" : "scorecard";
}

function normalizeMatrixLayout(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "subjects-as-rows" || raw === "subjects-as-columns") return raw;
  return "auto";
}

function sanitizeId(value, fallbackId) {
  const raw = String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  return raw || fallbackId;
}

function normalizeSubjectsSpec(subjects = null) {
  if (!subjects || typeof subjects !== "object") return null;
  const minCount = Math.max(2, Number(subjects.minCount) || 2);
  const maxCount = Math.max(minCount, Number(subjects.maxCount) || Math.max(4, minCount));
  const examples = Array.isArray(subjects.examples)
    ? subjects.examples.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    label: String(subjects.label || "Subjects").trim() || "Subjects",
    inputPrompt: String(subjects.inputPrompt || "List the subjects to compare").trim() || "List the subjects to compare",
    examples,
    minCount,
    maxCount,
  };
}

function normalizeDecisionHints(decisionHints = []) {
  if (!Array.isArray(decisionHints)) return [];
  return decisionHints
    .map((hint) => String(hint || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeAttributeList(attributes = []) {
  if (!Array.isArray(attributes)) return [];
  return attributes
    .map((attr, idx) => {
      const fallbackId = `attribute_${idx + 1}`;
      return {
        id: sanitizeId(attr?.id || attr?.label, fallbackId),
        label: String(attr?.label || fallbackId).trim() || fallbackId,
        brief: String(attr?.brief || attr?.description || "").trim(),
        derived: !!attr?.derived,
      };
    })
    .filter((attr) => attr.id && attr.label);
}

function normalizeDimensionsList(dimensions = []) {
  if (!Array.isArray(dimensions)) return [];
  return dimensions.map((dim, idx) => ({
    id: sanitizeId(dim?.id || dim?.label, `dimension_${idx + 1}`),
    label: String(dim?.label || `Dimension ${idx + 1}`).trim(),
    weight: Number(dim?.weight) || 1,
    enabled: dim?.enabled !== false,
    brief: String(dim?.brief || "").trim(),
    fullDef: String(dim?.fullDef || "").trim(),
    polarityHint: String(dim?.polarityHint || "").trim(),
    researchHints: normalizeResearchHints(dim?.researchHints),
  }));
}

function normalizeResearchConfigSpec(spec) {
  const outputMode = normalizeOutputMode(spec?.outputMode);
  const dimensions = normalizeDimensionsList(spec?.dimensions || []);
  const attributesFromSpec = normalizeAttributeList(spec?.attributes || []);
  const attributes = attributesFromSpec.length
    ? attributesFromSpec
    : (outputMode === "matrix"
      ? normalizeAttributeList(dimensions.map((dim) => ({
        id: dim.id,
        label: dim.label,
        brief: dim.brief,
      })))
      : []);
  const subjects = outputMode === "matrix" ? normalizeSubjectsSpec(spec?.subjects) : null;
  const matrixLayout = outputMode === "matrix" ? normalizeMatrixLayout(spec?.matrixLayout) : null;

  if (outputMode === "scorecard" && !dimensions.length) {
    throw new Error(`Research config "${spec?.id || spec?.name || "unknown"}" requires at least one dimension in scorecard mode.`);
  }
  if (outputMode === "matrix" && !attributes.length) {
    throw new Error(`Research config "${spec?.id || spec?.name || "unknown"}" requires at least one attribute in matrix mode.`);
  }
  if (outputMode === "matrix" && !subjects) {
    throw new Error(`Research config "${spec?.id || spec?.name || "unknown"}" requires a subjects spec in matrix mode.`);
  }

  return {
    outputMode,
    dimensions,
    attributes,
    subjects,
    matrixLayout,
    decisionHints: normalizeDecisionHints(spec?.decisionHints || DECISION_HINTS_BY_CONFIG[spec?.id] || []),
  };
}

const CONFIG_SPECS = [
  {
    "id": "startup-product-idea-validation",
    "name": "Startup / Product Idea Validation",
    "shortDescription": "Scores a startup or product idea across demand evidence, segment clarity, monetization logic, and defensibility. Structured to surface the dimensions founders most commonly misjudge before committing resources.",
    "methodology": "Dimension selection and weighting draw on four frameworks. Jobs to Be Done and Outcome-Driven Innovation (Christensen, Ulwick — https://strategyn.com/outcome-driven-innovation/) structure the problem severity and unmet need dimensions around behavioral evidence rather than feature gaps. Sequoia's Arc Product-Market Fit framework (https://sequoiacap.com/article/pmf-framework/) informs the market, product, and customer fit dimensions. Hamilton Helmer's 7 Powers (https://www.7powers.com/) structures the defensibility dimension around durable competitive advantage rather than feature differentiation. Marty Cagan's product discovery practice as documented in Empowered (https://www.svpg.com/empowered/) grounds the demand evidence dimension in behavioral signals over stated intent. Dimension weights reflect practitioner consensus that false positives on demand are the most costly early-stage error — problem severity and demand evidence carry higher weight than defensibility, which is typically emergent rather than demonstrable at idea stage.",
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
    "shortDescription": "Assesses whether a specific product or company has a credible right to win in a target market. Covers market attractiveness, local need fit, competitive position, regulatory friction, and route-to-market feasibility.",
    "methodology": "Dimension selection draws on McKinsey's where-to-play / how-to-win framework (https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/the-elements-of-strategy) and its emphasis that competitive advantage is context-specific to the intersection of offer, geography, and segment. Local need fit and route-to-market dimensions reflect BCG's local advantage research and Bain's strategic-fit logic. Richard Rumelt's diagnosis-first approach from Good Strategy Bad Strategy informs how the research frames the specific entry hypothesis before assessing dimensions (https://www.penguinrandomhouse.com/books/208668/good-strategy-bad-strategy-by-richard-rumelt/). The framework is structured as a right-to-win assessment for a specific offer in a specific market, not a generic country attractiveness ranking.",
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
    "shortDescription": "Produces a structured readout of a competitive situation — category structure, customer choice drivers, advantage quality, and relative positioning risk. Designed for go/no-go strategy decisions, not feature comparison.",
    "methodology": "Dimension selection draws on Hamilton Helmer's 7 Powers framework (https://www.7powers.com/) for the advantage quality and moat dimensions, and McKinsey's granular competitive advantage approach (https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/strategys-biggest-blind-spot-erosion-of-competitive-advantage) for customer choice driver dimensions. The Jobs to Be Done lens (Christensen) informs the competitive positioning dimension. Feature comparison is deliberately excluded as a primary dimension following the practitioner guidance in Marty Cagan's Inspired (https://www.svpg.com/inspired-2/) and ProductPlan's competitive analysis frameworks — feature parity analysis systematically underweights the factors that actually drive customer selection and retention. The Critic is specifically calibrated to challenge the inference that an incumbent's outdated appearance indicates structural weakness, which is among the most common errors in competitive analysis.",
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
    "shortDescription": "Evaluates whether a capability should be built in-house, purchased from a vendor, or handled through a hybrid approach. Scores strategic criticality, time-to-value, integration burden, vendor risk, and internal readiness.",
    "methodology": "Dimension selection and weighting draw on BCG's buy-and-build strategy framework (https://www.bcg.com/publications/2025/buy-and-build-strategy-unlocks-greater-ops-tech-value), which favors hybrid approaches when companies require both execution speed and strategic differentiation. McKinsey's competitive advantage and strategic flexibility framing informs the strategic criticality dimension (https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/how-strategy-champions-win). Bain's execution-first sequencing logic informs the time-to-value dimension. Marty Cagan's product operating model framing from SVPG (https://www.svpg.com/) informs whether a capability materially affects product outcomes. Strategic criticality and time-to-value carry higher weight than total cost of ownership because the build-vs-buy decision is rarely reducible to a cost comparison — capabilities that shape competitive advantage warrant different treatment from infrastructure.",
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
    "shortDescription": "Screens an investment target or M&A candidate across strategic fit, market quality, advantage durability, revenue quality, team risk, and value-creation logic. Structured to surface expensive false positives before diligence spend.",
    "methodology": "Dimension selection combines M&A practice frameworks from McKinsey (https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/done-deal-why-many-large-transactions-fail-to-create-value), BCG, and Bain with venture-quality filters from Sequoia (https://sequoiacap.com/article/pmf-framework/) and a16z (https://a16z.com/). Strategic fit and value-creation logic dimensions follow the McKinsey finding that deals creating shareholder value are primarily those with clear strategic rationale rather than financial engineering. Quality of advantage draws on Hamilton Helmer's 7 Powers (https://www.7powers.com/) applied to the target rather than the acquirer. Dimension weights reflect the practitioner objective of avoiding expensive false positives — strategic fit and advantage quality carry higher weight than market excitement signals, which are more visible but less predictive of deal value.",
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
    "shortDescription": "Assesses whether a product expansion — new feature, adjacent segment, or new geography — is strategically sound. Scores core strength transferability, customer pull, adjacency attractiveness, operational readiness, and cannibalization risk.",
    "methodology": "Dimension selection draws on McKinsey's core-to-adjacent expansion framework (https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/how-top-performers-use-innovation-to-grow-within-and-beyond-the-core), BCG's adjacency strategy work, and Chris Zook's Profit from the Core (https://www.bain.com/insights/profit-from-the-core/) for the core strength transferability dimension. Customer pull evidence draws on Sequoia's product-market fit signals framework (https://sequoiacap.com/article/pmf-framework/) and SVPG's product discovery practice (https://www.svpg.com/empowered/). Dimension weights reflect the consensus that expansions reusing an existing competitive edge outperform those requiring new capability development from scratch — core strength transferability carries the highest weight as the dimension most predictive of whether the expansion creates sustainable value.",
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
  },
  {
    "id": "market-sizing-tam-sam-som",
    "name": "Market Sizing (TAM/SAM/SOM)",
    "shortDescription": "Evaluates the credibility and defensibility of a market sizing case — scoring demand evidence, segment definition, methodology rigor, growth trajectory, and reachability. Dimensions score evidence quality, not absolute market size.",
    "tabLabel": "Market Sizing",
    "outputMode": "scorecard",
    "methodology": "Dimension selection draws on bottom-up market sizing methodology as documented in Sequoia's market sizing guidance (https://sequoiacap.com/article/pmf-framework/) and a16z's market analysis frameworks (https://a16z.com/), both of which emphasize segment-specific evidence over top-down industry reports. The bottom-up vs top-down triangulation approach follows the standard methodology described in Y Combinator's startup curriculum (https://www.ycombinator.com/library/4D-how-to-plan-an-mvp) and Bill Gurley's market size framework (https://abovethecrowd.com/2011/05/24/all-revenue-is-not-created-equal-the-keys-to-the-10x-revenue-club/). Dimensions score the quality and defensibility of the evidence, not the absolute scale of the numbers — a $3M local market with rigorous bottom-up evidence scores higher than a $50B global TAM supported only by a single analyst report. Estimated TAM/SAM/SOM figures appear as metadata on the research question rather than as scored dimensions.",
    "relatedDiscovery": true,
    "dimensions": [
      {
        "id": "demand-evidence-quality",
        "label": "Demand Evidence Quality",
        "weight": 22,
        "enabled": true,
        "brief": "How well demand is evidenced via behavioral signals rather than stated intent.",
        "fullDef": "What it measures: How strongly market demand is backed by observed buyer behavior.\nWhy it matters: Top-down sizing without behavioral demand evidence often inflates TAM and misleads sequencing.\n\nScoring rubric:\n- 5 (Strong): Multiple independent behavioral signals show active demand (budgeted spend, repeated buying triggers, concrete workarounds, or high-intent conversion signals) in the defined segment.\n- 4 (Good): Demand is clearly supported by at least one strong behavioral signal plus several directional indicators.\n- 3 (Moderate): Demand appears plausible but is supported mainly by interviews, intent statements, or partial proxies.\n- 2 (Weak): Evidence is mostly narrative (trend decks, broad market claims) with little segment-level behavior.\n- 1 (Poor): Little credible evidence that buyers are actively trying to solve or pay for this problem."
      },
      {
        "id": "market-definition-clarity",
        "label": "Market Definition Clarity",
        "weight": 18,
        "enabled": true,
        "brief": "How precisely segment boundaries are defined (role, company type, geo, trigger).",
        "fullDef": "What it measures: Precision of TAM/SAM/SOM boundaries by segment, role, geography, and trigger.\nWhy it matters: Ambiguous scope creates false comparability and hides unreachable sub-markets.\n\nScoring rubric:\n- 5 (Strong): Boundaries are explicit and operationally testable, with clear inclusion/exclusion logic and consistent segment language.\n- 4 (Good): Scope is mostly clear, though one boundary (such as geography or buyer role) still needs refinement.\n- 3 (Moderate): Segment definition exists but still groups materially different buyers or contexts.\n- 2 (Weak): Market definition relies on broad labels (for example SMB or enterprise) without operational boundaries.\n- 1 (Poor): No clear market boundary; TAM/SAM/SOM labels are used without defensible scope."
      },
      {
        "id": "size-estimation-methodology",
        "label": "Size Estimation Methodology",
        "weight": 18,
        "enabled": true,
        "brief": "Whether sizing is built bottom-up with clear assumptions vs top-down headline extrapolation.",
        "fullDef": "What it measures: Method quality behind TAM/SAM/SOM calculations.\nWhy it matters: Weak methodology can produce precise-looking numbers with low decision value.\n\nScoring rubric:\n- 5 (Strong): Sizing uses explicit bottom-up logic with transparent assumptions and triangulation against independent benchmarks.\n- 4 (Good): Method is mostly bottom-up and transparent, with limited reliance on top-down sanity checks.\n- 3 (Moderate): Mix of bottom-up and top-down methods, with partial assumption transparency.\n- 2 (Weak): Sizing is mostly top-down extrapolation with weak assumption traceability.\n- 1 (Poor): Method is unclear, inconsistent, or unsupported by verifiable inputs."
      },
      {
        "id": "growth-trajectory",
        "label": "Growth Trajectory",
        "weight": 12,
        "enabled": true,
        "brief": "Whether demand trajectory is expanding, stable, or contracting with credible evidence.",
        "fullDef": "What it measures: Direction and durability of demand growth in the scoped market.\nWhy it matters: A large market with weak or volatile growth can still be a poor near-term priority.\n\nScoring rubric:\n- 5 (Strong): Multiple recent indicators show sustained growth tailwinds and durable adoption momentum.\n- 4 (Good): Growth outlook is positive with credible evidence, though durability is less certain.\n- 3 (Moderate): Growth is mixed across subsegments or time periods.\n- 2 (Weak): Signs of stagnation, cyclicality, or slowing demand are material.\n- 1 (Poor): Market trajectory is flat-to-declining with limited evidence of reversal."
      },
      {
        "id": "reachability",
        "label": "Reachability",
        "weight": 18,
        "enabled": true,
        "brief": "Whether this market can be reached realistically with current GTM, budget, and channel access.",
        "fullDef": "What it measures: Practical ability to access and convert the scoped market.\nWhy it matters: TAM can be large while practical SOM remains small due to channel, budget, or trust barriers.\n\nScoring rubric:\n- 5 (Strong): Clear, evidence-backed channels can reach the target segment with realistic budget and conversion assumptions.\n- 4 (Good): Reach path is credible, though one or two execution assumptions remain unproven.\n- 3 (Moderate): Reachability is plausible but uncertain across channel efficiency or conversion steps.\n- 2 (Weak): Access depends on expensive or low-confidence channels with thin validation.\n- 1 (Poor): Market is largely unreachable under current GTM constraints."
      },
      {
        "id": "competitive-density",
        "label": "Competitive Density",
        "weight": 12,
        "enabled": true,
        "brief": "How crowded the space is with credible alternatives competing for the same budget.",
        "fullDef": "What it measures: Intensity of direct and substitute competition for the same budget.\nWhy it matters: Crowded markets compress share capture and make SOM assumptions fragile.\n\nScoring rubric:\n- 5 (Strong): Competitive pressure is manageable due to clear wedge, defensible differentiation, or under-served pockets.\n- 4 (Good): Competition is present but does not obviously block viable entry.\n- 3 (Moderate): Competition is meaningful; success depends on strong execution and positioning.\n- 2 (Weak): Market is crowded with capable alternatives and limited visible whitespace.\n- 1 (Poor): Competitive intensity is severe enough to make projected SOM capture unrealistic."
      }
    ]
  },
  {
    "id": "icp-customer-persona-matrix",
    "name": "ICP / Customer Persona",
    "shortDescription": "Profiles 2–4 customer segments across behavioral pain, decision triggers, willingness to pay, and acquisition channels. Output is a comparison matrix — one column per segment — designed to identify the strongest initial wedge.",
    "tabLabel": "ICP / Persona",
    "outputMode": "matrix",
    "matrixLayout": "subjects-as-columns",
    "methodology": "Attribute selection draws on three frameworks. Jobs to Be Done and Outcome-Driven Innovation (Christensen, Ulwick — https://strategyn.com/outcome-driven-innovation/) structure the core pain and current workarounds attributes around the job the customer is trying to accomplish rather than demographics or feature preferences. The decision trigger attribute follows the demand-side sales approach documented in Competing Against Luck (Christensen, Hall, Dillon, Duncan — https://www.harpercollins.com/products/competing-against-luck-clayton-m-christenstenscott-d-anthonykarl-t-ulwickdavid-s-duncan). The ICP vs buyer persona distinction — account-level fit vs individual decision-maker profile — follows the framework established by OpenView Partners (https://openviewpartners.com/blog/ideal-customer-profile/) and widely adopted in B2B SaaS go-to-market practice. Willingness to pay and procurement friction attributes draw on Van Westendorp's pricing sensitivity methodology and SVPG's customer discovery interview practice (https://www.svpg.com/inspired-2/).",
    "relatedDiscovery": true,
    "subjects": {
      "label": "Customer Segments",
      "inputPrompt": "Describe 2-4 distinct customer segments or personas you want to profile",
      "examples": ["Early-stage SaaS founders", "Enterprise IT Directors", "Bootstrapped agency owners"],
      "minCount": 2,
      "maxCount": 4
    },
    "attributes": [
      { "id": "company-context", "label": "Company / Context", "brief": "Company type, size, stage, industry, and operating model." },
      { "id": "buyer-role", "label": "Buyer Role", "brief": "Decision-maker role and daily end-user role(s)." },
      { "id": "core-pain", "label": "Core Pain", "brief": "Specific behavioral problem this segment experiences." },
      { "id": "current-workarounds", "label": "Current Workarounds", "brief": "What they do today instead of buying your product." },
      { "id": "decision-trigger", "label": "Decision Trigger", "brief": "What event/threshold moves them to active buying." },
      { "id": "willingness-to-pay", "label": "Willingness to Pay", "brief": "Evidence-based pricing range, model preference, and procurement friction." },
      { "id": "acquisition-channels", "label": "Acquisition Channels", "brief": "Where this persona is most reachable with high intent." },
      { "id": "editorial-priority", "label": "Editorial Priority", "brief": "Directional wedge recommendation and rationale.", "derived": true }
    ]
  },
  {
    "id": "competitors-comparison-matrix",
    "name": "Competitors Comparison",
    "shortDescription": "Maps a set of competitors across target ICP, positioning, strengths, weaknesses, PMF signal, and moat quality. Output is a comparison matrix — one row or column per competitor — designed to identify gaps and positioning opportunities.",
    "tabLabel": "Competitors Comparison",
    "outputMode": "matrix",
    "matrixLayout": "auto",
    "methodology": "Attribute selection draws on Hamilton Helmer's 7 Powers framework (https://www.7powers.com/) for the strengths, moat assessment, and PMF signal attributes — evaluating whether competitors hold durable advantages rather than temporary feature leads. The customer choice drivers attribute follows McKinsey's granular competitive advantage methodology (https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/strategys-biggest-blind-spot-erosion-of-competitive-advantage). The Jobs to Be Done lens (Christensen) informs the core positioning attribute — categorizing competitors by the job they perform for buyers rather than by vendor messaging. Feature checklists are excluded as a primary attribute following the practitioner guidance in Marty Cagan's Inspired (https://www.svpg.com/inspired-2/) — feature comparison systematically misidentifies the factors driving customer choice. The Critic is specifically calibrated to challenge gaps described without evidence of user demand, and PMF signal cells that conflate funding with actual user adoption.",
    "relatedDiscovery": false,
    "subjects": {
      "label": "Competitors",
      "inputPrompt": "List the competitors to analyze - direct and indirect",
      "examples": ["Notion", "Coda", "Confluence", "Linear"],
      "minCount": 2,
      "maxCount": 8
    },
    "attributes": [
      { "id": "target-icp", "label": "Target ICP", "brief": "Who they actually sell to by segment and buyer role." },
      { "id": "core-positioning", "label": "Core Positioning", "brief": "Primary value claim and job-to-be-done focus." },
      { "id": "pricing-model", "label": "Pricing Model", "brief": "Pricing structure, tiers, and approximate price points." },
      { "id": "key-strengths", "label": "Key Strengths", "brief": "Durable advantages: distribution, switching costs, ecosystem, data." },
      { "id": "key-weaknesses", "label": "Key Weaknesses", "brief": "Structural gaps, common complaints, and failure modes." },
      { "id": "pmf-signal", "label": "PMF Signal", "brief": "Evidence of adoption quality beyond funding headlines." },
      { "id": "gaps-opportunities", "label": "Gaps / Opportunities", "brief": "Underserved needs or segments with evidence." },
      { "id": "moat-assessment", "label": "Moat Assessment", "brief": "How defensible current position is under attack.", "derived": true }
    ]
  },
  {
    "id": "channel-gtm-analysis-scorecard",
    "name": "Channel / GTM Analysis (Scorecard)",
    "shortDescription": "Assesses whether a proposed GTM strategy is structurally viable — scoring ICP-channel fit, distribution advantage, CAC sustainability, channel-product fit, and competitive density. Use this when you have a specific GTM hypothesis to pressure-test.",
    "tabLabel": "GTM Strategy",
    "outputMode": "scorecard",
    "methodology": "Dimension selection draws on Brian Balfour's channel-product-market fit framework (https://brianbalfour.com/essays/channel-model-fit-for-user-acquisition), which holds that sustainable growth requires three-way fit between channel, product, and market rather than channel reach alone. Andrew Chen's distribution moat and cold start research (https://andrewchen.com/professional/) informs the distribution advantage dimension. The go-to-market motion taxonomy — self-serve PLG, sales-led, partner-led, community-led — follows OpenView Partners' product-led growth framework (https://openviewpartners.com/product-led-growth/). Dimension weights reflect the principle that ICP-channel fit and distribution advantage are structural — they determine whether the GTM is viable at all — while CAC sustainability and competitive density refine execution once structural viability is established.",
    "relatedDiscovery": true,
    "dimensions": [
      {
        "id": "icp-channel-fit",
        "label": "ICP-Channel Fit",
        "weight": 22,
        "enabled": true,
        "brief": "Whether target ICP actually inhabits and responds to the proposed channels.",
        "fullDef": "What it measures: Fit between chosen channels and the actual behavior of the target ICP.\nWhy it matters: GTM plans fail when channels are selected from generic best practices rather than segment behavior.\n\nScoring rubric:\n- 5 (Strong): Strong evidence shows the ICP is active in the channel and converts through this motion for comparable offers.\n- 4 (Good): Fit is credible with meaningful supporting evidence, though conversion assumptions are partly inferred.\n- 3 (Moderate): Some alignment exists, but evidence is mixed or segment coverage is incomplete.\n- 2 (Weak): Channel choice is mostly assumption-driven with limited ICP-specific behavior proof.\n- 1 (Poor): Little evidence the ICP uses or responds to the proposed channels."
      },
      {
        "id": "distribution-advantage",
        "label": "Distribution Advantage",
        "weight": 20,
        "enabled": true,
        "brief": "Whether founder/company has structural head-start in the chosen channel mix.",
        "fullDef": "What it measures: Structural leverage the team has in distribution execution.\nWhy it matters: Without structural advantage, CAC and ramp time often break otherwise sensible GTM plans.\n\nScoring rubric:\n- 5 (Strong): Team has clear channel leverage (audience, partner access, brand trust, founder reach, or embedded distribution) validated by comparable outcomes.\n- 4 (Good): At least one tangible advantage exists and appears actionable.\n- 3 (Moderate): Some advantage signals exist but are narrow or weakly validated.\n- 2 (Weak): Distribution plan depends mostly on generic execution without structural edge.\n- 1 (Poor): No visible distribution advantage over peers in the same channels."
      },
      {
        "id": "cac-sustainability",
        "label": "CAC Sustainability",
        "weight": 18,
        "enabled": true,
        "brief": "Whether expected CAC is compatible with likely unit economics.",
        "fullDef": "What it measures: Durability of acquisition economics under realistic assumptions.\nWhy it matters: Early GTM appears promising until CAC, payback, or conversion assumptions are stress-tested.\n\nScoring rubric:\n- 5 (Strong): Evidence supports CAC/payback assumptions that remain viable under conservative conversion and retention scenarios.\n- 4 (Good): Economics look healthy with limited sensitivity to key assumptions.\n- 3 (Moderate): Economics are plausible but sensitive to one or two major assumptions.\n- 2 (Weak): CAC sustainability is doubtful without optimistic conversion, pricing, or retention.\n- 1 (Poor): Acquisition economics are structurally unattractive on realistic assumptions."
      },
      {
        "id": "channel-product-fit",
        "label": "Channel-Product Fit",
        "weight": 15,
        "enabled": true,
        "brief": "Whether product complexity, price, and buying process match channel constraints.",
        "fullDef": "What it measures: Compatibility between product buying motion and channel mechanics.\nWhy it matters: Channel mismatch (for example enterprise product in self-serve channel) creates avoidable GTM friction.\n\nScoring rubric:\n- 5 (Strong): Channel mechanics align well with product complexity, contract size, and buyer process.\n- 4 (Good): Fit is mostly strong, with manageable frictions.\n- 3 (Moderate): Fit is mixed; additional enablement or motion changes are likely needed.\n- 2 (Weak): Major mismatch between channel behavior and product sales reality.\n- 1 (Poor): Channel and product motion are fundamentally misaligned."
      },
      {
        "id": "competitive-channel-density",
        "label": "Competitive Channel Density",
        "weight": 13,
        "enabled": true,
        "brief": "How crowded proposed channels are with capable competitors for the same ICP.",
        "fullDef": "What it measures: Degree of competitive saturation inside selected channels.\nWhy it matters: Channel crowding can erase marginal advantage and inflate acquisition costs.\n\nScoring rubric:\n- 5 (Strong): Competitive saturation is manageable relative to differentiation, message quality, and channel economics.\n- 4 (Good): Crowding is present but still leaves practical room for efficient acquisition.\n- 3 (Moderate): Density is meaningful; success depends on consistent execution quality.\n- 2 (Weak): Channels are heavily contested with limited evidence of efficient wedge entry.\n- 1 (Poor): Saturation is severe enough to make channel-led growth unlikely."
      },
      {
        "id": "time-to-first-signal",
        "label": "Time to First Signal",
        "weight": 12,
        "enabled": true,
        "brief": "How quickly the proposed approach can produce actionable learning signals.",
        "fullDef": "What it measures: Speed at which GTM setup yields actionable feedback loops.\nWhy it matters: Long time-to-signal delays iteration and amplifies burn risk.\n\nScoring rubric:\n- 5 (Strong): Plan can produce high-quality learning signals quickly (typically weeks) with clear instrumentation.\n- 4 (Good): Signal loop is reasonably fast, though some dependencies could delay readouts.\n- 3 (Moderate): Signal timeline is acceptable but uncertain.\n- 2 (Weak): Meaningful signal likely arrives late, slowing learning velocity.\n- 1 (Poor): Time-to-signal is too slow for efficient GTM iteration."
      }
    ]
  },
  {
    "id": "channel-gtm-analysis-matrix",
    "name": "Channel / GTM Analysis (Matrix)",
    "shortDescription": "Compares 2–8 acquisition channels across ICP reach, estimated CAC, competitive density, founder advantage, and channel-product fit. Output is a comparison matrix designed to support channel prioritization decisions.",
    "tabLabel": "GTM Channels",
    "outputMode": "matrix",
    "matrixLayout": "subjects-as-rows",
    "methodology": "Attribute selection applies Brian Balfour's channel-product-market fit framework (https://brianbalfour.com/essays/channel-model-fit-for-user-acquisition) at the per-channel level to compare acquisition options rather than assess a single GTM strategy holistically. CAC estimates are calibrated against current B2B and B2C benchmarks from sources including FirstPageSage, Profitwell, and OpenView Partners' SaaS benchmarks (https://openviewpartners.com/saas-benchmarks-report/) rather than derived from model assumptions alone. Andrew Chen's cold start and distribution moat research (https://andrewchen.com/professional/) informs the founder advantage attribute. The Critic is specifically instructed to challenge CAC estimates that assume reply rates or conversion rates above current industry benchmarks, and to flag ICP reach claims inferred from a channel's general audience rather than segment-specific evidence.",
    "relatedDiscovery": true,
    "subjects": {
      "label": "Channels",
      "inputPrompt": "List the acquisition channels or GTM motions to compare",
      "examples": ["Product Hunt launch", "SEO / content", "LinkedIn outbound", "Community-led", "Paid social"],
      "minCount": 2,
      "maxCount": 8
    },
    "attributes": [
      { "id": "icp-reach", "label": "ICP Reach", "brief": "Whether channel contains the target ICP in meaningful density." },
      { "id": "estimated-cac", "label": "Estimated CAC", "brief": "Evidence-based CAC range with assumptions and caveats." },
      { "id": "competitive-density", "label": "Competitive Density", "brief": "Intensity of competitor activity in this channel for the same ICP." },
      { "id": "founder-advantage", "label": "Founder Advantage", "brief": "Structural team advantage in this channel." },
      { "id": "time-to-first-signal", "label": "Time to First Signal", "brief": "How quickly this channel yields actionable data." },
      { "id": "channel-product-fit", "label": "Channel-Product Fit", "brief": "Fit between product complexity/price and channel mechanics." },
      { "id": "verdict", "label": "Verdict", "brief": "Prioritize / test small / deprioritize recommendation.", "derived": true }
    ]
  }
];

export const RESEARCH_CONFIGS = CONFIG_SPECS.map((spec) => ({
  ...normalizeResearchConfigSpec(spec),
  id: spec.id,
  slug: spec.slug || URL_SLUG_BY_CONFIG[spec.id] || spec.id,
  name: spec.name,
  tabLabel: spec.tabLabel || spec.name,
  engineVersion: "1.0.0",
  inputSpec: normalizeInputSpec(spec.inputSpec || INPUT_SPEC_BY_CONFIG[spec.id] || {}),
  framingFields: normalizeFramingFields(spec.framingFields || DEFAULT_FRAMING_FIELDS),
  relatedDiscovery: spec.relatedDiscovery !== false,
  methodology: spec.methodology || "",
  shortDescription: deriveShortDescription(spec.shortDescription || spec.methodology || spec.name),
  prompts: BASE_PROMPTS,
  models: SHARED_MODELS,
  deepAssist: SHARED_DEEP_ASSIST,
  limits: SHARED_LIMITS,
}));

export const DEFAULT_RESEARCH_CONFIG = RESEARCH_CONFIGS[0];

export default DEFAULT_RESEARCH_CONFIG;
