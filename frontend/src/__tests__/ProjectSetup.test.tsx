// TQ-018 acceptance criteria: "A user can create a project end-to-end through the UI."
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { ProjectSetup } from "../pages/ProjectSetup";

// ProjectSetup redirects to /login the instant it renders unauthenticated (see its useEffect
// guard), so — unlike Dashboard.test.tsx's simpler pattern, which doesn't route through
// <Routes> — this test needs login() to actually finish *before* ProjectSetup ever mounts,
// or the redirect fires on the unauthenticated flash and the test never reaches the form.
function AuthedThen({ children }: { children: ReactNode }) {
  const { login, isAuthenticated } = useAuth();
  useEffect(() => {
    if (!isAuthenticated) {
      login({ tenantId: "t1", email: "steward@example.com", role: "STEWARD" });
    }
  }, [isAuthenticated, login]);
  if (!isAuthenticated) return null;
  return <>{children}</>;
}

describe("ProjectSetup page", () => {
  let createProjectBody: unknown = null;

  beforeEach(() => {
    createProjectBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/auth/dev-token")) {
          return new Response(JSON.stringify({ token: "fake-token" }), { status: 200 });
        }
        if (url.includes("/v1/projects") && init?.method === "POST") {
          createProjectBody = JSON.parse(init.body as string);
          return new Response(
            JSON.stringify({ id: "proj-1", ...(createProjectBody as object), status: "draft" }),
            { status: 201 }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits domain, source system, target system, and environment; owner is implicit", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/projects/new"]}>
        <AuthProvider>
          <Routes>
            <Route
              path="/projects/new"
              element={
                <AuthedThen>
                  <ProjectSetup />
                </AuthedThen>
              }
            />
            <Route path="/dashboard" element={<div>Dashboard landed</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Owner is shown read-only, not editable — matches the backend deriving it from the JWT.
    // login() resolves asynchronously (it goes through the mocked dev-token fetch), so the
    // form only appears once that completes — findBy* waits for it.
    expect(await screen.findByText(/owner: steward@example\.com/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/project name/i), "Q1 Supplier Cleanup");
    await user.type(screen.getByLabelText(/source system/i), "Oracle EBS");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(screen.getByText("Dashboard landed")).toBeInTheDocument());

    expect(createProjectBody).toMatchObject({
      name: "Q1 Supplier Cleanup",
      sourceSystem: "Oracle EBS",
      domain: "Direct Procurement",
      targetSystem: "SAP S/4HANA",
      environment: "dev",
    });
  });

  it("shows a validation error and does not submit when required fields are blank", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/projects/new"]}>
        <AuthProvider>
          <Routes>
            <Route
              path="/projects/new"
              element={
                <AuthedThen>
                  <ProjectSetup />
                </AuthedThen>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    const createButton = await screen.findByRole("button", { name: /create project/i });
    await user.click(createButton);
    expect(await screen.findByText(/required/i)).toBeInTheDocument();
    expect(createProjectBody).toBeNull();
  });
});
