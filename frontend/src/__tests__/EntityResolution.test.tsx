// TQ-038 acceptance criteria: "A steward can review a match candidate pair side-by-side and
// record a decision."
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { EntityResolution } from "../pages/EntityResolution";

function AuthedThen({ children }: { children: ReactNode }) {
  const { login, isAuthenticated } = useAuth();
  useEffect(() => {
    if (!isAuthenticated) {
      login({ tenantId: "t1", email: "steward@example.com", role: "APPROVER" });
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
            path="/projects/:projectId/entity-resolution"
            element={
              <AuthedThen>
                <EntityResolution />
              </AuthedThen>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

const MATCH_SUMMARY = {
  id: "match-1",
  match_method: "fuzzy",
  confidence: 0.73,
  evidence: { signals: [{ type: "name_similarity", detail: "Name trigram similarity 0.80", score: 0.8 }] },
  decision: "needs_review",
  decided_by_user_id: null,
  decided_at: null,
  created_at: "2026-08-12T00:00:00.000Z",
  business_partner_id: "bp-1",
  business_partner_name: "Acme Corp",
  candidate_business_partner_id: "bp-2",
  candidate_business_partner_name: "Acme Corporation",
};

const MATCH_DETAIL = {
  match: MATCH_SUMMARY,
  businessPartner: {
    id: "bp-1",
    primary_name: "Acme Corp",
    bp_type: "organization",
    source_system: "Legacy ERP",
    status: "active",
    addresses: [],
    identifiers: [{ id: "id-1", identifier_type: "tax_id", identifier_value: "123456789", issuing_authority: null }],
    suppliers: [{ id: "sup-1", business_partner_id: "bp-1", supplier_number: "V-1", source_system: "SAP-ERP", status: "active" }],
  },
  candidateBusinessPartner: {
    id: "bp-2",
    primary_name: "Acme Corporation",
    bp_type: "organization",
    source_system: "Legacy ERP",
    status: "active",
    addresses: [],
    identifiers: [],
    suppliers: [],
  },
};

function mockFetchImpl(overrides: Record<string, (url: string) => Response> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/auth/dev-token")) {
      return new Response(JSON.stringify({ token: "fake-token" }), { status: 200 });
    }
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) return handler(url);
    }
    if (url.includes("/v1/projects/proj-1/entity-matches/run") && init?.method === "POST") {
      return new Response(JSON.stringify({ candidatesFound: 1, newOrRefreshed: 1, skippedAlreadyDecided: 0 }), { status: 200 });
    }
    if (url.includes("/v1/projects/proj-1/entity-matches")) {
      return new Response(JSON.stringify({ matches: [MATCH_SUMMARY] }), { status: 200 });
    }
    if (url.includes("/v1/entity-matches/match-1/decision")) {
      return new Response(JSON.stringify({ ...MATCH_SUMMARY, decision: "merge" }), { status: 200 });
    }
    if (url.includes("/v1/entity-matches/match-1")) {
      return new Response(JSON.stringify(MATCH_DETAIL), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("EntityResolution page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetchImpl());
  });

  it("lists candidate matches with confidence and lets a steward select one to compare", async () => {
    renderAt("/projects/proj-1/entity-resolution");

    expect(await screen.findByText(/Acme Corp.*Acme Corporation/)).toBeInTheDocument();
    expect(screen.getByText(/73%/)).toBeInTheDocument();

    await userEvent.click(screen.getByText(/Acme Corp.*Acme Corporation/));

    // Side-by-side comparison, including each side's linked Supplier "roles" (TQ-037).
    await waitFor(() => expect(screen.getByText("Compare candidates")).toBeInTheDocument());
    expect(screen.getAllByText(/Acme Corp/).length).toBeGreaterThan(0);
    expect(screen.getByText(/SAP-ERP\/V-1/)).toBeInTheDocument();
    expect(screen.getByText(/Name trigram similarity/)).toBeInTheDocument();
  });

  it("records a decision and reflects it in the list", async () => {
    renderAt("/projects/proj-1/entity-resolution");

    await screen.findByText(/Acme Corp.*Acme Corporation/);
    const mergeButtons = screen.getAllByRole("button", { name: "Merge" });
    await userEvent.click(mergeButtons[0]);

    await waitFor(() => expect(screen.getByText(/Decision: Merge/)).toBeInTheDocument());
  });

  it("shows the guardrail's own denial message when a merge is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchImpl({
        "/v1/entity-matches/match-1/decision": () =>
          new Response(
            JSON.stringify({
              error:
                'Role "STEWARD" cannot record a "merge" decision — this requires "approve" permission (AGENTS.md Do-Not-Do #3: no unauthorized automatic merges).',
            }),
            { status: 403 }
          ),
      })
    );

    renderAt("/projects/proj-1/entity-resolution");
    await screen.findByText(/Acme Corp.*Acme Corporation/);
    const mergeButtons = screen.getAllByRole("button", { name: "Merge" });
    await userEvent.click(mergeButtons[0]);

    expect(await screen.findByText(/requires "approve" permission/)).toBeInTheDocument();
  });

  it("offers to run matching and shows an empty state when there are no candidates yet", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchImpl({
        "/v1/projects/proj-1/entity-matches/run": () => new Response("should not be reached", { status: 500 }),
      })
    );
    // Override the base list response to empty for this test.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/auth/dev-token")) {
          return new Response(JSON.stringify({ token: "fake-token" }), { status: 200 });
        }
        if (url.includes("/v1/projects/proj-1/entity-matches")) {
          return new Response(JSON.stringify({ matches: [] }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );

    renderAt("/projects/proj-1/entity-resolution");
    expect(await screen.findByText(/No candidate matches yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run matching/i })).toBeInTheDocument();
  });
});
