import { useCallback, useEffect, useMemo, useState } from "react";
import App from "./App.jsx";
import LandingPage from "./components/LandingPage.jsx";
import SiteFooter from "./components/SiteFooter.jsx";
import { RESEARCH_CONFIGS, DEFAULT_RESEARCH_CONFIG } from "../../configs/research-configurations.js";
import { HOME_PATH, getResearchPath, resolveAppRoute } from "./lib/routes";
import { applySeoMeta, buildHomeSeoMeta, buildNotFoundSeoMeta, buildResearchSeoMeta } from "./lib/seo";
import { downloadDebugLogsBundle } from "./lib/debug";

function readPathname() {
  if (typeof window === "undefined") return HOME_PATH;
  return window.location.pathname || HOME_PATH;
}

export default function ResearchitRoot() {
  const [pathname, setPathname] = useState(readPathname);
  const route = useMemo(() => resolveAppRoute(pathname), [pathname]);
  const handleExportDebugLogs = useCallback(() => {
    downloadDebugLogsBundle();
  }, []);

  const navigateTo = useCallback((nextPath, options = {}) => {
    const replace = !!options.replace;
    const nextRoute = resolveAppRoute(nextPath);
    const targetPath = nextRoute.shouldRedirect ? nextRoute.canonicalPath : nextRoute.pathname;
    if (typeof window !== "undefined" && window.location.pathname !== targetPath) {
      window.history[replace ? "replaceState" : "pushState"]({}, "", targetPath);
    }
    setPathname(targetPath);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPopState = () => setPathname(readPathname());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!route.shouldRedirect || !route.canonicalPath) return;
    if (typeof window !== "undefined" && window.location.pathname !== route.canonicalPath) {
      window.history.replaceState({}, "", route.canonicalPath);
    }
    setPathname(route.canonicalPath);
  }, [route.shouldRedirect, route.canonicalPath]);

  useEffect(() => {
    if (route.kind === "research" && route.config) {
      applySeoMeta(buildResearchSeoMeta(route.config));
      return;
    }
    if (route.kind === "not_found") {
      applySeoMeta(buildNotFoundSeoMeta(pathname));
      return;
    }
    applySeoMeta(buildHomeSeoMeta());
  }, [route, pathname]);

  if (route.kind === "research") {
    return (
      <App
        initialConfigId={route.config.id}
        routeConfigId={route.config.id}
        onActiveConfigChange={(config) => navigateTo(getResearchPath(config))}
        onNavigateHome={() => navigateTo(HOME_PATH)}
      />
    );
  }

  if (route.kind === "not_found") {
    return (
      <div className="landing-shell">
        <header className="landing-top">
          <div className="landing-brand">
            <div className="landing-logo-box">
              <span className="landing-logo-number">75</span>
              <span className="landing-logo-mark">Re</span>
            </div>
            <button
              type="button"
              className="landing-brand-home"
              onClick={() => navigateTo(HOME_PATH)}>
              Research it
            </button>
          </div>
        </header>
        <main className="landing-main">
          <section className="landing-hero">
            <p className="landing-kicker">404</p>
            <h1>Page Not Found</h1>
            <p className="landing-subtitle">
              This page does not exist. Open the homepage or go directly to the default research workspace.
            </p>
            <div className="landing-hero-actions">
              <button
                type="button"
                className="landing-btn landing-btn-primary"
                onClick={() => navigateTo(HOME_PATH)}>
                Go to Homepage
              </button>
              <button
                type="button"
                className="landing-btn landing-btn-ghost"
                onClick={() => navigateTo(getResearchPath(DEFAULT_RESEARCH_CONFIG))}>
                Open Workspace
              </button>
            </div>
          </section>
        </main>
        <SiteFooter onExportDebug={handleExportDebugLogs} />
      </div>
    );
  }

  return (
    <LandingPage
      featuredConfigs={RESEARCH_CONFIGS}
      onOpenConfig={(config) => navigateTo(getResearchPath(config))}
      onOpenWorkspace={() => navigateTo(getResearchPath(DEFAULT_RESEARCH_CONFIG))}
      onExportDebug={handleExportDebugLogs}
    />
  );
}
