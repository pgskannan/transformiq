// BP/Supplier Resolution screen (TQ-038, SRS §18). DoD: "A steward can review a match
// candidate pair side-by-side and record a decision." Covers candidate comparison, evidence
// display, "roles" (each side's linked Supplier records, TQ-037), and all four decision
// states (TQ-034) including the merge guardrail (TQ-035) — a denied merge attempt surfaces
// the backend's own permission-denied message rather than a generic failure banner.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  api,
  ApiError,
  type BusinessPartnerDetail,
  type EntityMatchDetail,
  type EntityMatchSummary,
  type MatchDecision,
} from "../lib/api";

function formatConfidence(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function confidenceColor(score: number): string {
  if (score >= 0.9) return "#1a7f37";
  if (score >= 0.7) return "#9a6700";
  return "#cf222e";
}

const DECISION_LABELS: Record<MatchDecision, string> = {
  needs_review: "Needs Review",
  merge: "Merge",
  keep_separate: "Keep Separate",
  reject: "Reject",
};

function BpSideCard({ bp, title }: { bp: BusinessPartnerDetail; title: string }) {
  const primary = bp.addresses.find((a) => a.is_primary) ?? bp.addresses[0];
  return (
    <div style={{ flex: 1, border: "1px solid #d0d7de", borderRadius: 6, padding: 12 }}>
      <p style={{ margin: 0, fontSize: 12, color: "#555", textTransform: "uppercase" }}>{title}</p>
      <p style={{ margin: "4px 0", fontWeight: 600 }}>{bp.primary_name}</p>
      <p style={{ margin: "2px 0", fontSize: 13, color: "#555" }}>Type: {bp.bp_type}</p>
      {bp.source_system && <p style={{ margin: "2px 0", fontSize: 13, color: "#555" }}>Source: {bp.source_system}</p>}
      {primary && (
        <p style={{ margin: "2px 0", fontSize: 13, color: "#555" }}>
          {[primary.line1, primary.city, primary.postal_code, primary.country_code].filter(Boolean).join(", ")}
        </p>
      )}
      {bp.identifiers.length > 0 && (
        <p style={{ margin: "6px 0 2px", fontSize: 13 }}>
          <strong>Identifiers:</strong>{" "}
          {bp.identifiers.map((i) => `${i.identifier_type}=${i.identifier_value}`).join(", ")}
        </p>
      )}
      <p style={{ margin: "6px 0 2px", fontSize: 13 }}>
        <strong>Roles (Suppliers):</strong>{" "}
        {bp.suppliers.length === 0
          ? "none"
          : bp.suppliers.map((s) => `${s.source_system ?? "?"}/${s.supplier_number ?? "?"}`).join(", ")}
      </p>
    </div>
  );
}

export function EntityResolution() {
  const { token, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();

  const [matches, setMatches] = useState<EntityMatchSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntityMatchDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) navigate("/login");
  }, [isAuthenticated, navigate]);

  async function loadMatches() {
    if (!isAuthenticated || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const { matches: result } = await api.listEntityMatches(token!, projectId);
      setMatches(result);
    } catch {
      setError("Could not load candidate matches. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, projectId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    api
      .getEntityMatch(token!, selectedId)
      .then(setDetail)
      .catch(() => setError("Could not load match detail."));
  }, [selectedId, token]);

  async function handleRun() {
    if (!projectId) return;
    setRunning(true);
    setError(null);
    try {
      await api.runEntityMatching(token!, projectId);
      await loadMatches();
    } catch {
      setError("Could not run entity matching.");
    } finally {
      setRunning(false);
    }
  }

  async function handleDecide(matchId: string, decision: MatchDecision) {
    setDecidingId(matchId);
    setDecisionError(null);
    try {
      const updated = await api.decideEntityMatch(token!, matchId, decision);
      setMatches((prev) => prev.map((m) => (m.id === matchId ? { ...m, ...updated } : m)));
      if (detail?.match.id === matchId) {
        setDetail({ ...detail, match: { ...detail.match, ...updated } });
      }
    } catch (err) {
      // Surfaces the guardrail's own 403 message (TQ-035) rather than a generic failure —
      // a steward should see WHY a merge was refused, not just that it was.
      setDecisionError(err instanceof ApiError ? err.message : "Could not record this decision.");
    } finally {
      setDecidingId(null);
    }
  }

  if (!isAuthenticated) return null;

  return (
    <main style={{ maxWidth: 1100, margin: "40px auto", fontFamily: "sans-serif" }}>
      <header style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <Link to="/dashboard">&larr; Back to dashboard</Link>
          <h1 style={{ margin: "8px 0 0" }}>BP / Supplier Resolution</h1>
          <p style={{ margin: "4px 0 0", color: "#555" }}>
            {matches.length} candidate {matches.length === 1 ? "pair" : "pairs"}
          </p>
        </div>
        <button onClick={handleRun} disabled={running}>
          {running ? "Running…" : "Run matching"}
        </button>
      </header>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {decisionError && <p style={{ color: "crimson" }}>{decisionError}</p>}
      {loading && <p>Loading…</p>}

      {!loading && matches.length === 0 && !error && (
        <p>No candidate matches yet. Click "Run matching" to detect duplicate Business Partners.</p>
      )}

      <div style={{ display: "flex", gap: 24 }}>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, flex: detail ? "0 0 380px" : 1 }}>
          {matches.map((m) => (
            <li
              key={m.id}
              onClick={() => setSelectedId(m.id)}
              style={{
                border: selectedId === m.id ? "2px solid #0969da" : "1px solid #d0d7de",
                borderRadius: 6,
                padding: 12,
                marginBottom: 10,
                cursor: "pointer",
              }}
            >
              <p style={{ margin: 0, fontWeight: 600 }}>
                {m.business_partner_name} &harr; {m.candidate_business_partner_name}
              </p>
              <p style={{ margin: "4px 0", fontSize: 13, color: "#555" }}>
                {m.match_method} match ·{" "}
                <span style={{ color: confidenceColor(m.confidence), fontWeight: 600 }}>
                  {formatConfidence(m.confidence)}
                </span>{" "}
                confidence · Decision: {DECISION_LABELS[m.decision]}
              </p>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {(Object.keys(DECISION_LABELS) as MatchDecision[]).map((decision) => (
                  <button
                    key={decision}
                    disabled={decidingId === m.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDecide(m.id, decision);
                    }}
                    style={{ fontWeight: m.decision === decision ? 700 : 400 }}
                  >
                    {DECISION_LABELS[decision]}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>

        {detail && (
          <section style={{ flex: 1 }}>
            <h2 style={{ fontSize: 18 }}>Compare candidates</h2>
            <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
              <BpSideCard bp={detail.businessPartner} title="Business Partner" />
              <BpSideCard bp={detail.candidateBusinessPartner} title="Candidate" />
            </div>
            <h3 style={{ fontSize: 15 }}>Evidence</h3>
            <ul>
              {detail.match.evidence.signals.map((s, i) => (
                <li key={i}>
                  <strong>{s.type}</strong>: {s.detail} (score {s.score.toFixed(2)})
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
