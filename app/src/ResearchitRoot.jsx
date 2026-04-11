import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import App from "./App.jsx";
import LandingPage from "./components/LandingPage.jsx";
import SiteFooter from "./components/SiteFooter.jsx";
import AuthModal from "./components/AuthModal.jsx";
import Spinner from "./components/Spinner.jsx";
import { RESEARCH_CONFIGS, DEFAULT_RESEARCH_CONFIG } from "../../configs/research-configurations.js";
import { HOME_PATH, getResearchPath, resolveAppRoute } from "./lib/routes";
import { applySeoMeta, buildHomeSeoMeta, buildNotFoundSeoMeta, buildResearchSeoMeta } from "./lib/seo";
import { downloadDebugLogsBundle } from "./lib/debug";
import { fetchSession, requestMagicLink, signOutSession, verifyMagicToken } from "./lib/accountApi";

function readPathname() {
  if (typeof window === "undefined") return HOME_PATH;
  return window.location.pathname || HOME_PATH;
}

function readSearch() {
  if (typeof window === "undefined") return "";
  return window.location.search || "";
}

function buildAuthButton({ user, loading, onOpenAuth, onSignOut }) {
  if (loading) {
    return (
      <button
        type="button"
        disabled
        style={{
          border: "1px solid var(--ck-line)",
          background: "var(--ck-surface)",
          color: "var(--ck-muted)",
          padding: "6px 10px",
          fontSize: 12,
          fontWeight: 700,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}>
        <Spinner size={10} color="var(--ck-muted)" /> Session
      </button>
    );
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={onOpenAuth}
        style={{
          border: "1px solid var(--ck-line)",
          background: "var(--ck-surface)",
          color: "var(--ck-text)",
          padding: "6px 10px",
          fontSize: 12,
          fontWeight: 700,
        }}>
        Sign in
      </button>
    );
  }

  return (
    <details style={{ position: "relative" }}>
      <summary
        style={{
          border: "1px solid var(--ck-line)",
          background: "var(--ck-surface)",
          color: "var(--ck-text)",
          padding: "6px 10px",
          fontSize: 12,
          fontWeight: 700,
        }}>
        {user.email}
      </summary>
      <div
        style={{
          position: "absolute",
          right: 0,
          top: "calc(100% + 6px)",
          minWidth: 220,
          border: "1px solid var(--ck-line)",
          background: "var(--ck-surface)",
          padding: 8,
          display: "grid",
          gap: 8,
          zIndex: 60,
        }}>
        <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.4 }}>
          Account storage is enabled. Researches sync to your signed-in account.
        </div>
        <button
          type="button"
          onClick={(e) => {
            onSignOut?.();
            e.currentTarget.closest("details")?.removeAttribute("open");
          }}
          style={{
            border: "1px solid var(--ck-line)",
            background: "var(--ck-surface-soft)",
            color: "var(--ck-text)",
            padding: "6px 8px",
            fontSize: 12,
            fontWeight: 700,
            textAlign: "left",
          }}>
          Sign out
        </button>
      </div>
    </details>
  );
}

export default function ResearchitRoot() {
  const [pathname, setPathname] = useState(readPathname);
  const [search, setSearch] = useState(readSearch);
  const route = useMemo(() => resolveAppRoute(pathname), [pathname]);
  const callbackHandledRef = useRef("");

  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authRequesting, setAuthRequesting] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authDelivery, setAuthDelivery] = useState("");
  const [authDevMagicLink, setAuthDevMagicLink] = useState("");
  const [authCallbackError, setAuthCallbackError] = useState("");

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
    setSearch("");
  }, []);

  const refreshSession = useCallback(async () => {
    setAuthLoading(true);
    try {
      const payload = await fetchSession();
      setAuthUser(payload?.authenticated ? payload.user || null : null);
    } catch (_) {
      setAuthUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const handleRequestMagicLink = useCallback(async (email) => {
    const targetPath = route.kind === "research" && route.config
      ? getResearchPath(route.config)
      : pathname;
    setAuthRequesting(true);
    setAuthError("");
    setAuthDelivery("");
    setAuthDevMagicLink("");
    try {
      const payload = await requestMagicLink(email, targetPath || "/");
      setAuthDelivery(payload?.delivery || "email");
      setAuthDevMagicLink(String(payload?.devMagicLink || ""));
    } catch (err) {
      setAuthError(err?.message || "Failed to send magic link");
    } finally {
      setAuthRequesting(false);
    }
  }, [pathname, route]);

  const handleSignOut = useCallback(async () => {
    try {
      await signOutSession();
    } catch (_) {
      // no-op
    }
    setAuthUser(null);
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPopState = () => {
      setPathname(readPathname());
      setSearch(readSearch());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!route.shouldRedirect || !route.canonicalPath) return;
    if (typeof window !== "undefined" && window.location.pathname !== route.canonicalPath) {
      window.history.replaceState({}, "", route.canonicalPath);
    }
    setPathname(route.canonicalPath);
    setSearch("");
  }, [route.shouldRedirect, route.canonicalPath]);

  useEffect(() => {
    if (route.kind !== "auth_callback") return;
    const params = new URLSearchParams(search || "");
    const token = String(params.get("token") || "").trim();
    if (!token) {
      setAuthCallbackError("Missing token in magic link.");
      return;
    }
    if (callbackHandledRef.current === token) return;
    callbackHandledRef.current = token;

    let cancelled = false;
    setAuthLoading(true);
    setAuthCallbackError("");

    (async () => {
      try {
        const verified = await verifyMagicToken(token);
        if (cancelled) return;
        setAuthUser(verified?.user || null);
        const nextFromResponse = String(verified?.nextPath || "").trim();
        const nextFromQuery = String(params.get("next") || "").trim();
        const targetPath = nextFromResponse || nextFromQuery || HOME_PATH;
        navigateTo(targetPath, { replace: true });
      } catch (err) {
        if (cancelled) return;
        setAuthCallbackError(err?.message || "Magic link verification failed.");
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigateTo, route.kind, search]);

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

  const authButton = buildAuthButton({
    user: authUser,
    loading: authLoading,
    onOpenAuth: () => {
      setAuthError("");
      setAuthDelivery("");
      setAuthDevMagicLink("");
      setAuthModalOpen(true);
    },
    onSignOut: handleSignOut,
  });

  if (route.kind === "auth_callback") {
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
          <div className="landing-top-actions">{authButton}</div>
        </header>
        <main className="landing-main">
          <section className="landing-hero" style={{ maxWidth: 680 }}>
            {authLoading ? (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--ck-muted)", fontSize: 14 }}>
                <Spinner size={12} color="var(--ck-muted)" /> Verifying magic link...
              </div>
            ) : authCallbackError ? (
              <>
                <p className="landing-kicker">Sign-in error</p>
                <h1>Magic link is invalid or expired.</h1>
                <p className="landing-subtitle">{authCallbackError}</p>
                <div className="landing-hero-actions">
                  <button
                    type="button"
                    className="landing-btn landing-btn-primary"
                    onClick={() => {
                      setAuthModalOpen(true);
                      navigateTo(HOME_PATH, { replace: true });
                    }}>
                    Request new link
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="landing-kicker">Signed in</p>
                <h1>Your session is ready.</h1>
                <p className="landing-subtitle">Redirecting to your workspace...</p>
              </>
            )}
          </section>
        </main>
        <SiteFooter onExportDebug={handleExportDebugLogs} />
        <AuthModal
          open={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          onRequestLink={handleRequestMagicLink}
          requesting={authRequesting}
          error={authError}
          delivery={authDelivery}
          devMagicLink={authDevMagicLink}
          defaultEmail={authUser?.email || ""}
        />
      </div>
    );
  }

  if (route.kind === "research") {
    return (
      <>
        <App
          initialConfigId={route.config.id}
          routeConfigId={route.config.id}
          onActiveConfigChange={(config) => navigateTo(getResearchPath(config))}
          onNavigateHome={() => navigateTo(HOME_PATH)}
          authUser={authUser}
          authLoading={authLoading}
          onOpenAuth={() => {
            setAuthError("");
            setAuthDelivery("");
            setAuthDevMagicLink("");
            setAuthModalOpen(true);
          }}
          onSignOut={handleSignOut}
        />
        <AuthModal
          open={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          onRequestLink={handleRequestMagicLink}
          requesting={authRequesting}
          error={authError}
          delivery={authDelivery}
          devMagicLink={authDevMagicLink}
          defaultEmail={authUser?.email || ""}
        />
      </>
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
          <div className="landing-top-actions">{authButton}</div>
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
        <AuthModal
          open={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          onRequestLink={handleRequestMagicLink}
          requesting={authRequesting}
          error={authError}
          delivery={authDelivery}
          devMagicLink={authDevMagicLink}
          defaultEmail={authUser?.email || ""}
        />
      </div>
    );
  }

  return (
    <>
      <LandingPage
        featuredConfigs={RESEARCH_CONFIGS}
        onOpenConfig={(config) => navigateTo(getResearchPath(config))}
        onOpenWorkspace={() => navigateTo(getResearchPath(DEFAULT_RESEARCH_CONFIG))}
        onExportDebug={handleExportDebugLogs}
        authUser={authUser}
        authLoading={authLoading}
        onOpenAuth={() => {
          setAuthError("");
          setAuthDelivery("");
          setAuthDevMagicLink("");
          setAuthModalOpen(true);
        }}
        onSignOut={handleSignOut}
      />
      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onRequestLink={handleRequestMagicLink}
        requesting={authRequesting}
        error={authError}
        delivery={authDelivery}
        devMagicLink={authDevMagicLink}
        defaultEmail={authUser?.email || ""}
      />
    </>
  );
}
