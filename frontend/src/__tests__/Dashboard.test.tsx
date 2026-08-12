import { render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { Dashboard } from "../pages/Dashboard";

// Small helper: logs a fake user in synchronously before rendering Dashboard, so we're
// testing "already authenticated" rendering rather than the login flow (covered separately
// in Login.test.tsx).
function LoggedInDashboard() {
  const { login } = useAuth();
  login({ tenantId: "t1", email: "steward@example.com", role: "STEWARD" });
  return <Dashboard />;
}

describe("Dashboard page", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/auth/dev-token")) {
          return new Response(JSON.stringify({ token: "fake-token" }), { status: 200 });
        }
        if (url.includes("/v1/projects")) {
          return new Response(JSON.stringify({ projects: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the authenticated shell and an empty project list", async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <LoggedInDashboard />
        </AuthProvider>
      </BrowserRouter>
    );

    expect(screen.getByText("Project Dashboard")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no projects yet/i)).toBeInTheDocument());
  });
});
