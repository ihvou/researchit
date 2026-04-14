import { useMemo, useState } from "react";

const SOURCE_STATUS_META = {
  cited: {
    label: "Cited",
    color: "#1c5937",
    borderColor: "rgba(28, 89, 55, 0.3)",
    background: "rgba(28, 89, 55, 0.08)",
  },
  corroborating: {
    label: "Corroborating",
    color: "#1f4e73",
    borderColor: "rgba(31, 78, 115, 0.3)",
    background: "rgba(31, 78, 115, 0.08)",
  },
  unverified: {
    label: "Unverified",
    color: "#7a611a",
    borderColor: "rgba(122, 97, 26, 0.3)",
    background: "rgba(122, 97, 26, 0.08)",
  },
  excluded_marketing: {
    label: "Excluded: marketing",
    color: "#7b2a2a",
    borderColor: "rgba(123, 42, 42, 0.28)",
    background: "rgba(123, 42, 42, 0.08)",
  },
  excluded_stale: {
    label: "Excluded: stale",
    color: "#7b2a2a",
    borderColor: "rgba(123, 42, 42, 0.28)",
    background: "rgba(123, 42, 42, 0.08)",
  },
};

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeSourceUniverse(summary = {}) {
  return {
    cited: Number(summary?.cited || 0),
    corroborating: Number(summary?.corroborating || 0),
    unverified: Number(summary?.unverified || 0),
    excludedMarketing: Number(summary?.excludedMarketing || 0),
    excludedStale: Number(summary?.excludedStale || 0),
    total: Number(summary?.total || 0),
  };
}

function sourceStatusLabel(status = "") {
  const key = cleanText(status).toLowerCase();
  return SOURCE_STATUS_META[key] || SOURCE_STATUS_META.unverified;
}

export default function SourcesList({ sources, sourceUniverse = null, showSourceUniverse = false }) {
  const [universeExpanded, setUniverseExpanded] = useState(false);
  const universe = useMemo(() => normalizeSourceUniverse(sourceUniverse), [sourceUniverse]);
  const normalizedSources = Array.isArray(sources) ? sources : [];
  if (!normalizedSources.length) return null;
  const hasUniverse = showSourceUniverse && universe.total > 0;

  return (
    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "3px 0" }}>
      {hasUniverse ? (
        <div style={{ width: "100%", marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => setUniverseExpanded((value) => !value)}
            style={{
              border: "1px solid var(--ck-line)",
              background: "var(--ck-surface-soft)",
              color: "var(--ck-text)",
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.7,
              padding: "4px 8px",
              cursor: "pointer",
            }}>
            Source Universe {universeExpanded ? "▲" : "▼"}
          </button>
          {universeExpanded ? (
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, fontSize: 10, color: "var(--ck-muted)" }}>
              <span>Cited {universe.cited}</span>
              <span>Corroborating {universe.corroborating}</span>
              <span>Unverified {universe.unverified}</span>
              <span>Excluded marketing {universe.excludedMarketing}</span>
              <span>Excluded stale {universe.excludedStale}</span>
              <span>Total {universe.total}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <span style={{ fontSize: 10, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.7, marginRight: 6, flexShrink: 0 }}>
        Sources:
      </span>
      {normalizedSources.map((s, i) => (
        <span key={i} style={{
          display: "inline-flex", alignItems: "baseline", gap: 4,
          background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)",
          borderRadius: 2, padding: "2px 8px", fontSize: 11, marginRight: 5, marginBottom: 3,
        }}>
          {s.url
            ? <a href={s.url} target="_blank" rel="noopener noreferrer"
                style={{ color: "var(--ck-text)", textDecoration: "none" }}
                onMouseOver={e => e.target.style.textDecoration = "underline"}
                onMouseOut={e => e.target.style.textDecoration = "none"}>
                {s.name}
              </a>
            : <span style={{ color: "var(--ck-text)" }}>{s.name}</span>}
          <span style={{
            fontSize: 9,
            color: sourceStatusLabel(s.displayStatus).color,
            border: `1px solid ${sourceStatusLabel(s.displayStatus).borderColor}`,
            background: sourceStatusLabel(s.displayStatus).background,
            padding: "1px 5px",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}>
            {sourceStatusLabel(s.displayStatus).label}
          </span>
          {s.quote && <span style={{ color: "var(--ck-muted)" }}>- {s.quote}</span>}
        </span>
      ))}
    </div>
  );
}
