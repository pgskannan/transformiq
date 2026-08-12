// TQ-029 acceptance criteria: "A steward can view field-level quality scores and inferred
// types for an ingested dataset."
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { DataProfile } from "../pages/DataProfile";

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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route
            path="/projects/:projectId/data-profile"
            element={
              <AuthedThen>
                <DataProfile />
              </AuthedThen>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("DataProfile page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/auth/dev-token")) {
          return new Response(JSON.stringify({ token: "fake-token" }), { status: 200 });
        }
        if (url.includes("/v1/projects/proj-1/datasets")) {
          return new Response(
            JSON.stringify({ datasets: [{ id: "ds-1", project_id: "proj-1", name: "suppliers" }] }),
            { status: 200 }
          );
        }
        if (url.includes("/v1/datasets/ds-1/versions")) {
          return new Response(
            JSON.stringify({ versions: [{ id: "v-1", dataset_id: "ds-1", version_number: 1, row_count: 4 }] }),
            { status: 200 }
          );
        }
        if (url.includes("/v1/dataset-versions/v-1/profile")) {
          return new Response(
            JSON.stringify({
              profile: {
                id: "profile-1",
                dataset_version_id: "v-1",
                row_count: 4,
                column_count: 2,
                overall_quality_score: 0.875,
                profiled_at: "2026-08-12T00:00:00.000Z",
              },
              fields: [
                {
                  id: "field-1",
                  column_name: "supplier_id",
                  inferred_type: "integer",
                  semantic_type: "identifier",
                  row_count: 4,
                  null_count: 0,
                  distinct_count: 4,
                  completeness: 1,
                  uniqueness: 1,
                  validity: 1,
                  conformity: 1,
                  consistency: 1,
                  quality_score: 1,
                },
                {
                  id: "field-2",
                  column_name: "contact_email",
                  inferred_type: "string",
                  semantic_type: "email",
                  row_count: 4,
                  null_count: 1,
                  distinct_count: 3,
                  completeness: 0.75,
                  uniqueness: 1,
                  validity: 1,
                  conformity: 1,
                  consistency: 1,
                  quality_score: 0.9375,
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes("/v1/dataset-versions/v-1/anomalies")) {
          return new Response(
            JSON.stringify({
              anomalies: [
                {
                  id: "anomaly-1",
                  row_number: 3,
                  column_name: "contact_email",
                  anomaly_type: "null",
                  value: null,
                  detail: "Column \"contact_email\" is 75% complete elsewhere; this row's blank value stands out.",
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );
  });

  it("shows field-level quality scores and inferred/semantic types for an ingested dataset", async () => {
    renderAt("/projects/proj-1/data-profile");

    expect(await screen.findByText("supplier_id")).toBeInTheDocument();
    expect(screen.getByText("integer")).toBeInTheDocument();
    expect(screen.getByText("identifier")).toBeInTheDocument();
    // "contact_email" appears twice — once as a field name, once inside the anomaly detail.
    expect(screen.getAllByText("contact_email").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("email")).toBeInTheDocument();

    // Overall quality score and supplier_id's per-dimension scores all render as percentages
    // ("100%" appears several times — once per dimension for the perfect supplier_id row).
    expect(screen.getByText("88%")).toBeInTheDocument(); // overall: 0.875 -> 88%
    expect(screen.getAllByText("100%").length).toBeGreaterThan(0);

    // Anomaly surfaces too.
    expect(await screen.findByText(/Anomalies \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/stands out/)).toBeInTheDocument();
  });

  it("offers a 'Profile now' action when the latest version hasn't been profiled yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/auth/dev-token")) {
          return new Response(JSON.stringify({ token: "fake-token" }), { status: 200 });
        }
        if (url.includes("/v1/projects/proj-1/datasets")) {
          return new Response(
            JSON.stringify({ datasets: [{ id: "ds-1", project_id: "proj-1", name: "suppliers" }] }),
            { status: 200 }
          );
        }
        if (url.includes("/v1/datasets/ds-1/versions")) {
          return new Response(
            JSON.stringify({ versions: [{ id: "v-1", dataset_id: "ds-1", version_number: 1, row_count: 4 }] }),
            { status: 200 }
          );
        }
        if (url.includes("/v1/dataset-versions/v-1/profile")) {
          return new Response(JSON.stringify({ error: "No profile found for this dataset version" }), {
            status: 404,
          });
        }
        return new Response("not found", { status: 404 });
      })
    );

    renderAt("/projects/proj-1/data-profile");

    expect(await screen.findByText(/hasn't been profiled yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /profile now/i })).toBeInTheDocument();
  });

  it("shows an empty state when the project has no datasets yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/auth/dev-token")) {
          return new Response(JSON.stringify({ token: "fake-token" }), { status: 200 });
        }
        if (url.includes("/v1/projects/proj-1/datasets")) {
          return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );

    renderAt("/projects/proj-1/data-profile");

    expect(await screen.findByText(/no datasets have been ingested/i)).toBeInTheDocument();
  });
});
