// TQ-008 acceptance criteria: user can log in and land on an authenticated shell page.
// Stands in for real SSO (backend TQ-006) with a dev-token flow so the walking skeleton is
// demoable end to end today.
//
// Deliberately does NOT create tenants from here (that used to happen inline in Sprint 1).
// Since TQ-011 locked tenant creation behind a platform-admin-only header, a customer-facing
// login page has no business holding that key — tenant provisioning is an out-of-band admin
// operation in a real deployment. For local dev/demo, use the "Bootstrap a demo tenant" link
// below (see DevBootstrapTenant.tsx), which only exists in dev builds.
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/api";

const ROLES = ["VIEWER", "STEWARD", "APPROVER", "EXPORTER", "ADMIN"];

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [tenantId, setTenantId] = useState("");
  const [email, setEmail] = useState("steward@example.com");
  const [role, setRole] = useState("STEWARD");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login({ tenantId: tenantId.trim(), email, role });
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed. Is the backend running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>TransformIQ</h1>
      <p style={{ color: "#555" }}>
        Sprint walking skeleton — this stands in for real SSO login until Identity Platform
        (backend TQ-006) is wired up.
      </p>
      <form onSubmit={handleSubmit}>
        <label style={{ display: "block", marginBottom: 12 }}>
          Tenant ID
          <input
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            required
            placeholder="paste the tenant ID you were given"
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 12 }}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 12 }}>
          Role (dev-token stand-in only — a real IdP would assert this)
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ padding: "8px 16px" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {import.meta.env.DEV && (
        <p style={{ marginTop: 24, fontSize: 14 }}>
          No tenant yet? <Link to="/dev/bootstrap-tenant">Bootstrap a demo tenant</Link> (dev
          build only).
        </p>
      )}
    </main>
  );
}
