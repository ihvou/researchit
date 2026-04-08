import { RESEARCH_CONFIGS, DEFAULT_RESEARCH_CONFIG } from "../../../configs/research-configurations.js";

export const HOME_PATH = "/";
export const WORKSPACE_BASE_PATH = "/workspace";
export const LEGACY_RESEARCH_BASE_PATH = "/research";

function splitPath(pathname = "/") {
  const raw = String(pathname || "/").trim() || "/";
  const withoutQuery = raw.split("?")[0].split("#")[0] || "/";
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  const normalized = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : "/";
  return {
    raw: collapsed || "/",
    normalized: normalized || "/",
  };
}

function normalizeSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}

export function getConfigById(configId) {
  const target = String(configId || "").trim();
  if (!target) return DEFAULT_RESEARCH_CONFIG;
  return RESEARCH_CONFIGS.find((config) => config.id === target) || DEFAULT_RESEARCH_CONFIG;
}

export function getConfigSlug(config) {
  const raw = String(config?.slug || config?.id || DEFAULT_RESEARCH_CONFIG.slug || DEFAULT_RESEARCH_CONFIG.id).trim();
  return normalizeSlug(raw);
}

export function getConfigBySlug(slug) {
  const target = normalizeSlug(slug);
  if (!target) return null;
  return RESEARCH_CONFIGS.find((config) => getConfigSlug(config) === target) || null;
}

export function getResearchPath(configOrIdOrSlug = DEFAULT_RESEARCH_CONFIG) {
  let config = DEFAULT_RESEARCH_CONFIG;
  if (typeof configOrIdOrSlug === "object" && configOrIdOrSlug) {
    config = getConfigById(configOrIdOrSlug.id);
  } else {
    const value = String(configOrIdOrSlug || "").trim();
    const byId = RESEARCH_CONFIGS.find((item) => item.id === value);
    const bySlug = getConfigBySlug(value);
    config = byId || bySlug || DEFAULT_RESEARCH_CONFIG;
  }
  return `/${getConfigSlug(config)}/`;
}

export function getWorkspacePath(configOrIdOrSlug = DEFAULT_RESEARCH_CONFIG) {
  let config = DEFAULT_RESEARCH_CONFIG;
  if (typeof configOrIdOrSlug === "object" && configOrIdOrSlug) {
    config = getConfigById(configOrIdOrSlug.id);
  } else {
    const value = String(configOrIdOrSlug || "").trim();
    const byId = RESEARCH_CONFIGS.find((item) => item.id === value);
    const bySlug = getConfigBySlug(value);
    config = byId || bySlug || DEFAULT_RESEARCH_CONFIG;
  }
  return `${WORKSPACE_BASE_PATH}/${getConfigSlug(config)}/`;
}

export function resolveAppRoute(pathname = "/") {
  const { raw, normalized } = splitPath(pathname);

  if (normalized === HOME_PATH) {
    return {
      kind: "home",
      pathname: HOME_PATH,
      canonicalPath: HOME_PATH,
      shouldRedirect: false,
    };
  }

  if (normalized === WORKSPACE_BASE_PATH) {
    const config = DEFAULT_RESEARCH_CONFIG;
    const canonicalPath = getWorkspacePath(config);
    return {
      kind: "research",
      config,
      pathname: raw,
      canonicalPath,
      shouldRedirect: raw !== canonicalPath,
    };
  }

  if (normalized.startsWith(`${WORKSPACE_BASE_PATH}/`)) {
    let slug = normalized.slice(WORKSPACE_BASE_PATH.length + 1).split("/")[0];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      slug = String(slug || "");
    }
    const config = getConfigBySlug(slug);
    if (!config) {
      return {
        kind: "not_found",
        pathname: raw,
        canonicalPath: raw,
        shouldRedirect: false,
      };
    }
    const canonicalPath = getWorkspacePath(config);
    return {
      kind: "research",
      config,
      pathname: raw,
      canonicalPath,
      shouldRedirect: raw !== canonicalPath,
    };
  }

  if (normalized === LEGACY_RESEARCH_BASE_PATH) {
    const config = DEFAULT_RESEARCH_CONFIG;
    const canonicalPath = getWorkspacePath(config);
    return {
      kind: "research",
      config,
      pathname: raw,
      canonicalPath,
      shouldRedirect: true,
    };
  }

  if (normalized.startsWith(`${LEGACY_RESEARCH_BASE_PATH}/`)) {
    let slug = normalized.slice(LEGACY_RESEARCH_BASE_PATH.length + 1).split("/")[0];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      slug = String(slug || "");
    }
    const config = getConfigBySlug(slug);
    if (!config) {
      return {
        kind: "not_found",
        pathname: raw,
        canonicalPath: raw,
        shouldRedirect: false,
      };
    }
    const canonicalPath = getWorkspacePath(config);
    return {
      kind: "research",
      config,
      pathname: raw,
      canonicalPath,
      shouldRedirect: true,
    };
  }

  return {
    kind: "not_found",
    pathname: raw,
    canonicalPath: raw,
    shouldRedirect: false,
  };
}
