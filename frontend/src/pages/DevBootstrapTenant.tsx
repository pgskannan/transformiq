// Dev-only convenience page: creates a tenant via the platform-admin-gated endpoint so a
// local developer doesn't have to reach for curl/psql just to get a tenant ID for Login.tsx.
//
// This page (and its route registration in App.tsx) is compiled out of production builds —
// see the `import.meta.env.DEV` guard in App.tsx. `import.meta.env.DEV` is a Vite build-time
// constant (false in `vite build`), so this component and the key it reads are not present in
// a shipped bundle. It still requires VITE_DEV_PLATFORM_ADMIN_KEY to be set locally (matching
// the backend's PLATFORM_ADMIN_API_KEY) — see frontend/.env.example.
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";

export function DevBootstrapTenant() {
  const [name, setName] = useState("Acme Procurement");
  const [result, setResult] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const devKey = import.meta.env.VITE_DEV_PLATFORM_ADMIN_KEY as string | undefined;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!devKey) {
      setError(
        "VITE_DEV_PLATFORM_ADMIN_KEY is not set — copy frontend/.env.example to frontend/.env and match backend/.env's PLATFORM_ADMIN_API_KEY."
      );
      return;
    }
    setBusy(true);
    try {
      const tenant = await api.createTenant(name, devKey);
      setResult(tenant);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create tenant.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Bootstrap a demo tenant</h1>
      <p style={{ color: "#555" }}>
        Dev-only utility — not part of the product's real onboarding flow. In production, a
        tenant is provisioned out-of-band by a TransformIQ platform admin.
      </p>
      <form onSubmit={handleSubmit}>
        <label style={{ display: "block", marginBottom: 12 }}>
          Organization / tenant name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ padding: "8px 16px" }}>
          {busy ? "Creating…" : "Create tenant"}
        </button>
      </form>
      {result && (
        <div style={{ marginTop: 24, padding: 12, background: "#f0f8f0" }}>
          <p>
            Tenant created: <strong>{result.name}</strong>
          </p>
          <p>
            Tenant ID (paste into the login form): <code>{result.id}</code>
          </p>
        </div>
      )}
      <p style={{ marginTop: 24 }}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </main>
  );
}
