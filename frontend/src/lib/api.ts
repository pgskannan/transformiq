// Thin fetch wrapper around the backend's versioned API (see backend/src/routes). Every
// call goes through /v1/... per AGENTS.md §6 "explicit API versioning is mandatory".

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request to ${path} failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface Project {
  id: string;
  name: string;
  domain: string;
  source_system: string;
  target_system: string;
  environment: string;
  status: string;
  created_at: string;
}

export const api = {
  health: () => request<{ status: string; service: string; version: string }>("/v1/health"),

  // Dev-only login stand-in until a real OIDC provider is wired up (backend TQ-006).
  devLogin: (input: { tenantId: string; email: string; role: string }) =>
    request<{ token: string }>("/v1/auth/dev-token", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createTenant: (name: string) =>
    request<{ id: string; name: string }>("/v1/tenants", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  listProjects: (token: string) =>
    request<{ projects: Project[] }>("/v1/projects", {}, token),

  createProject: (
    token: string,
    input: {
      name: string;
      domain: string;
      sourceSystem: string;
      targetSystem: string;
      environment?: string;
    }
  ) =>
    request<Project>(
      "/v1/projects",
      { method: "POST", body: JSON.stringify(input) },
      token
    ),
};
