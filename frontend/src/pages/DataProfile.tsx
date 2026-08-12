// Data Profile screen (TQ-029, SRS §18). DoD: "A steward can view field-level quality scores
// and inferred types for an ingested dataset." Scope note: the backlog title also mentions
// "relationship discovery" — that's automated BP-relationship inference, which doesn't exist
// yet (TQ-028 only added manual relationship creation via the API; discovery is later-sprint
// entity-resolution work). This screen covers what's actually built: per-field quality
// dimensions (FR-PROF-001), semantic field types (FR-PROF-003), and anomalies (FR-PROF-002),
// for whichever dataset version has most recently been profiled.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  api,
  ApiError,
  type Dataset,
  type DatasetAnomaly,
  type DatasetProfile,
  type FieldProfile,
} from "../lib/api";

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// A simple traffic-light read on a [0,1] score — not a design system, just enough visual
// signal for a steward scanning a table of fields to spot the ones that need attention.
function scoreColor(score: number): string {
  if (score >= 0.9) return "#1a7f37";
  if (score >= 0.7) return "#9a6700";
  return "#cf222e";
}

export function DataProfile() {
  const { token, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();

  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [latestVersionId, setLatestVersionId] = useState<string | null>(null);
  const [versionNumber, setVersionNumber] = useState<number | null>(null);
  const [profile, setProfile] = useState<DatasetProfile | null>(null);
  const [fields, setFields] = useState<FieldProfile[]>([]);
  const [anomalies, setAnomalies] = useState<DatasetAnomaly[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reprofiling, setReprofiling] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) navigate("/login");
  }, [isAuthenticated, navigate]);

  // Load the project's datasets, default to the first one.
  useEffect(() => {
    if (!isAuthenticated || !projectId) return;
    api
      .listDatasets(token!, projectId)
      .then((res) => {
        setDatasets(res.datasets);
        setSelectedDatasetId((current) => current ?? res.datasets[0]?.id ?? null);
      })
      .catch(() => setError("Could not load datasets for this project. Is the backend running?"));
  }, [isAuthenticated, projectId, token]);

  // When the selected dataset changes, load its latest version and that version's profile.
  useEffect(() => {
    if (!isAuthenticated || !selectedDatasetId) return;
    setLoading(true);
    setError(null);
    setProfile(null);
    setFields([]);
    setAnomalies([]);

    (async () => {
      const { versions } = await api.listDatasetVersions(token!, selectedDatasetId);
      const latest = versions[0]; // GET .../versions already orders by version_number desc
      if (!latest) {
        setLatestVersionId(null);
        setVersionNumber(null);
        return;
      }
      setLatestVersionId(latest.id);
      setVersionNumber(latest.version_number);

      const profileResult = await api.getDatasetProfile(token!, latest.id);
      if (profileResult) {
        setProfile(profileResult.profile);
        setFields(profileResult.fields);
        const anomalyResult = await api.getDatasetAnomalies(token!, latest.id);
        setAnomalies(anomalyResult.anomalies);
      }
    })()
      .catch(() => setError("Could not load the data profile. Is the backend running?"))
      .finally(() => setLoading(false));
  }, [isAuthenticated, selectedDatasetId, token]);

  async function handleReprofile() {
    if (!latestVersionId) return;
    setReprofiling(true);
    setError(null);
    try {
      const { profile: newProfile } = await api.triggerProfiling(token!, latestVersionId);
      setProfile(newProfile);
      const [fieldsResult, anomalyResult] = await Promise.all([
        api.getDatasetProfile(token!, latestVersionId),
        api.getDatasetAnomalies(token!, latestVersionId),
      ]);
      setFields(fieldsResult?.fields ?? []);
      setAnomalies(anomalyResult.anomalies);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not re-profile this dataset.");
    } finally {
      setReprofiling(false);
    }
  }

  if (!isAuthenticated) return null;

  return (
    <main style={{ maxWidth: 960, margin: "40px auto", fontFamily: "sans-serif" }}>
      <header style={{ marginBottom: 24 }}>
        <Link to="/dashboard">&larr; Back to dashboard</Link>
        <h1 style={{ margin: "8px 0 0" }}>Data Profile</h1>
      </header>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {datasets.length === 0 && !error && (
        <p>No datasets have been ingested into this project yet.</p>
      )}

      {datasets.length > 0 && (
        <label style={{ display: "block", marginBottom: 20 }}>
          Dataset
          <select
            value={selectedDatasetId ?? ""}
            onChange={(e) => setSelectedDatasetId(e.target.value)}
            style={{ display: "block", width: "100%", maxWidth: 360, padding: 8, marginTop: 4 }}
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {loading && <p>Loading…</p>}

      {!loading && selectedDatasetId && latestVersionId && !profile && (
        <p>
          Version {versionNumber} of this dataset hasn't been profiled yet.{" "}
          <button onClick={handleReprofile} disabled={reprofiling}>
            {reprofiling ? "Profiling…" : "Profile now"}
          </button>
        </p>
      )}

      {!loading && profile && (
        <>
          <section
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
              padding: 16,
              border: "1px solid #d0d7de",
              borderRadius: 6,
            }}
          >
            <div>
              <p style={{ margin: 0, color: "#555" }}>
                Version {versionNumber} · {profile.row_count} rows · {profile.column_count} columns
              </p>
              <p style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 600 }}>
                <span style={{ color: scoreColor(profile.overall_quality_score) }}>
                  {formatScore(profile.overall_quality_score)}
                </span>{" "}
                overall quality
              </p>
            </div>
            <button onClick={handleReprofile} disabled={reprofiling}>
              {reprofiling ? "Re-profiling…" : "Re-profile"}
            </button>
          </section>

          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #d0d7de" }}>
                <th style={{ padding: 8 }}>Field</th>
                <th style={{ padding: 8 }}>Inferred type</th>
                <th style={{ padding: 8 }}>Semantic type</th>
                <th style={{ padding: 8 }}>Completeness</th>
                <th style={{ padding: 8 }}>Validity</th>
                <th style={{ padding: 8 }}>Conformity</th>
                <th style={{ padding: 8 }}>Consistency</th>
                <th style={{ padding: 8 }}>Uniqueness</th>
                <th style={{ padding: 8 }}>Quality score</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.id} style={{ borderBottom: "1px solid #eaeef2" }}>
                  <td style={{ padding: 8 }}>
                    <strong>{f.column_name}</strong>
                  </td>
                  <td style={{ padding: 8 }}>{f.inferred_type}</td>
                  <td style={{ padding: 8, color: f.semantic_type ? "#000" : "#8c959f" }}>
                    {f.semantic_type ?? "—"}
                  </td>
                  <td style={{ padding: 8 }}>{formatScore(f.completeness)}</td>
                  <td style={{ padding: 8 }}>{formatScore(f.validity)}</td>
                  <td style={{ padding: 8 }}>{formatScore(f.conformity)}</td>
                  <td style={{ padding: 8 }}>{formatScore(f.consistency)}</td>
                  <td style={{ padding: 8 }}>{formatScore(f.uniqueness)}</td>
                  <td style={{ padding: 8, fontWeight: 600, color: scoreColor(f.quality_score) }}>
                    {formatScore(f.quality_score)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <section>
            <h2 style={{ fontSize: 18 }}>Anomalies ({anomalies.length})</h2>
            {anomalies.length === 0 ? (
              <p style={{ color: "#555" }}>No anomalies flagged in this version.</p>
            ) : (
              <ul>
                {anomalies.map((a) => (
                  <li key={a.id}>
                    Row {a.row_number}, <strong>{a.column_name}</strong> ({a.anomaly_type}):{" "}
                    {a.detail}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
