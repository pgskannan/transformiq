// Project Setup UI (TQ-018, FR-PROJ-001, SRS §18 "Project Setup — domain, source systems,
// target ecosystem, owners, target packs"). Target-pack selection is out of scope until the
// target-pack model exists (Sprint 9+ per the roadmap); this covers everything else in the
// acceptance criteria: "A user can create a project end-to-end through the UI."
//
// Owner is deliberately not a form field: the backend derives owner_user_id from the caller's
// authenticated identity (see backend/src/routes/projects.ts), so there is nothing for the
// user to pick — it's shown read-only for confirmation instead. Letting the UI submit an
// arbitrary owner would be a privilege-escalation surface with no matching backend support.
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../lib/api";

// Matches the domain values already exercised in backend tests/docs (AGENTS.md §2.2 —
// "Direct and Indirect Procurement are distinct domains that share the same transformation
// engine"). Kept as a fixed set rather than free text so downstream domain-specific rule
// packs (Sprint 4+) have a stable value to key off of.
const DOMAINS = ["Direct Procurement", "Indirect Procurement"];

// SRS's initial target ecosystem (AGENTS.md §1: "SAP S/4HANA and SAP Ariba as the initial
// target systems"). Source systems are intentionally free text — the connector framework
// (FR-ING-005) that would let us offer a closed list doesn't exist yet, and legacy source
// landscapes vary a lot more than the two supported targets do.
const TARGET_SYSTEMS = ["SAP S/4HANA", "SAP Ariba"];
const ENVIRONMENTS = ["dev", "staging", "prod"];

export function ProjectSetup() {
  const { token, email, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [domain, setDomain] = useState(DOMAINS[0]);
  const [sourceSystem, setSourceSystem] = useState("");
  const [targetSystem, setTargetSystem] = useState(TARGET_SYSTEMS[0]);
  const [environment, setEnvironment] = useState(ENVIRONMENTS[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) navigate("/login");
  }, [isAuthenticated, navigate]);

  if (!isAuthenticated) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !sourceSystem.trim()) {
      setError("Project name and source system are required.");
      return;
    }
    setBusy(true);
    try {
      const project = await api.createProject(token!, {
        name: name.trim(),
        domain,
        sourceSystem: sourceSystem.trim(),
        targetSystem,
        environment,
      });
      navigate("/dashboard", { state: { justCreatedProjectId: project.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>New transformation project</h1>
      <p style={{ color: "#555" }}>
        Owner: {email} (set automatically from your signed-in identity)
      </p>

      <form onSubmit={handleSubmit}>
        <label style={{ display: "block", marginBottom: 12 }}>
          Project name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            // Deliberately no HTML `required` attribute: native constraint validation would
            // silently swallow the click (the submit event never fires) instead of running
            // our own validation message below, which is both more testable and gives a
            // clearer combined message when multiple fields are missing.
            placeholder="e.g. Q1 Supplier Master Cleanup"
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 12 }}>
          Domain
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          >
            {DOMAINS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "block", marginBottom: 12 }}>
          Source system
          <input
            value={sourceSystem}
            onChange={(e) => setSourceSystem(e.target.value)}
            placeholder="e.g. Legacy ERP, Oracle EBS, Coupa"
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 12 }}>
          Target system
          <select
            value={targetSystem}
            onChange={(e) => setTargetSystem(e.target.value)}
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          >
            {TARGET_SYSTEMS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "block", marginBottom: 12 }}>
          Environment
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          >
            {ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </label>

        {error && <p style={{ color: "crimson" }}>{error}</p>}

        <button type="submit" disabled={busy} style={{ padding: "8px 16px" }}>
          {busy ? "Creating…" : "Create project"}
        </button>{" "}
        <button type="button" onClick={() => navigate("/dashboard")} disabled={busy}>
          Cancel
        </button>
      </form>
    </main>
  );
}
