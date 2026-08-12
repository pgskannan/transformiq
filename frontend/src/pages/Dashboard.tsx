// Project Dashboard shell (SRS §18). Sprint 1 scope is just proving the authenticated
// shell + tenant-scoped API call works; full dashboard content (readiness, blockers, cost,
// progress) is later-sprint scope.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, type Project } from "../lib/api";

export function Dashboard() {
  const { token, tenantId, email, logout, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate("/login");
      return;
    }
    api
      .listProjects(token!)
      .then((res) => setProjects(res.projects))
      .catch(() => setError("Could not load projects. Is the backend running?"));
  }, [isAuthenticated, token, navigate]);

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", fontFamily: "sans-serif" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Project Dashboard</h1>
          <p style={{ color: "#555", margin: 0 }}>
            {email} · tenant {tenantId}
          </p>
        </div>
        <div>
          <Link to="/projects/new" style={{ marginRight: 12 }}>
            <button>New project</button>
          </Link>
          <button onClick={() => { logout(); navigate("/login"); }}>Sign out</button>
        </div>
      </header>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {projects.length === 0 ? (
        <p>
          No projects yet for this tenant. <Link to="/projects/new">Create one</Link> to get
          started.
        </p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong> — {p.domain} — {p.source_system} → {p.target_system} (
              {p.status})
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
