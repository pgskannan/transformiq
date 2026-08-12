// TQ-008 acceptance criteria: user can log in and land on an authenticated shell page.
// Stands in for real SSO (backend TQ-006) with a tenant-bootstrap + dev-token flow so the
// walking skeleton is demoable end to end today.
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../lib/api";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [tenantName, setTenantName] = useState("Acme Procurement");
  const [email, setEmail] = useState("steward@example.com");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const tenant = await api.createTenant(tenantName);
      await login({ tenantId: tenant.id, email, role: "STEWARD" });
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
        Sprint 1 walking skeleton — this stands in for real SSO login until Identity Platform
        (backend TQ-006) is wired up.
      </p>
      <form onSubmit={handleSubmit}>
        <label style={{ display: "block", marginBottom: 12 }}>
          Organization / tenant name
          <input
            value={tenantName}
            onChange={(e) => setTenantName(e.target.value)}
            required
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
        {error && <p style={{ color: "crimson" }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ padding: "8px 16px" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
