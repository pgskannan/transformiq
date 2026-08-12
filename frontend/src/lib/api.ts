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

// Shapes below mirror backend/src/db/types.ts's generated Kysely interfaces for the
// corresponding tables — kept as plain interfaces here (not shared/imported across the
// frontend/backend boundary) since the frontend build has no dependency on the backend
// package; see AGENTS.md on keeping the two apps independently deployable.
export interface Dataset {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface DatasetVersion {
  id: string;
  dataset_id: string;
  version_number: number;
  row_count: number | null;
  created_at: string;
}

export interface DatasetProfile {
  id: string;
  dataset_version_id: string;
  row_count: number;
  column_count: number;
  overall_quality_score: number;
  profiled_at: string;
}

export interface FieldProfile {
  id: string;
  column_name: string;
  inferred_type: string;
  semantic_type: string | null;
  row_count: number;
  null_count: number;
  distinct_count: number;
  completeness: number;
  uniqueness: number;
  validity: number;
  conformity: number;
  consistency: number;
  quality_score: number;
}

export interface DatasetAnomaly {
  id: string;
  row_number: number;
  column_name: string;
  anomaly_type: "null" | "malformed_value" | "outlier" | "suspicious_pattern";
  value: string | null;
  detail: string;
}

export const api = {
  health: () => request<{ status: string; service: string; version: string }>("/v1/health"),

  // Dev-only login stand-in until a real OIDC provider is wired up (backend TQ-006).
  devLogin: (input: { tenantId: string; email: string; role: string }) =>
    request<{ token: string }>("/v1/auth/dev-token", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Dev-only tenant bootstrap (see pages/DevBootstrapTenant.tsx — not reachable in a
  // production build). Real tenant provisioning is an out-of-band platform-admin operation
  // (backend TQ-011/tenants.ts requires x-platform-admin-key), not something a customer's
  // own login page should ever be able to trigger — that's why this is a separate function
  // taking the key explicitly rather than something Login/createProject can reach.
  createTenant: (name: string, platformAdminKey: string) =>
    request<{ id: string; name: string }>("/v1/tenants", {
      method: "POST",
      headers: { "x-platform-admin-key": platformAdminKey },
      body: JSON.stringify({ name }),
    }),

  listProjects: (token: string) =>
    request<{ projects: Project[] }>("/v1/projects", {}, token),

  getProject: (token: string, id: string) => request<Project>(`/v1/projects/${id}`, {}, token),

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

  // TQ-029 (Data Profile screen) additions below. See backend/src/routes/datasets.ts,
  // ingestion.ts, and profiling.ts for the corresponding server-side endpoints.
  listDatasets: (token: string, projectId: string) =>
    request<{ datasets: Dataset[] }>(`/v1/projects/${projectId}/datasets`, {}, token),

  listDatasetVersions: (token: string, datasetId: string) =>
    request<{ versions: DatasetVersion[] }>(`/v1/datasets/${datasetId}/versions`, {}, token),

  // Returns null (not a thrown ApiError) for the common, expected "not profiled yet" case —
  // GET .../profile 404s when no profiling run has completed for this version, which is a
  // normal state for a just-ingested version, not an error the UI should alarm on.
  getDatasetProfile: async (
    token: string,
    datasetVersionId: string
  ): Promise<{ profile: DatasetProfile; fields: FieldProfile[] } | null> => {
    try {
      return await request(`/v1/dataset-versions/${datasetVersionId}/profile`, {}, token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  getDatasetAnomalies: (token: string, datasetVersionId: string) =>
    request<{ anomalies: DatasetAnomaly[] }>(
      `/v1/dataset-versions/${datasetVersionId}/anomalies`,
      {},
      token
    ),

  triggerProfiling: (token: string, datasetVersionId: string) =>
    request<{ profile: DatasetProfile; anomalyCount: number }>(
      "/v1/profiling-runs",
      { method: "POST", body: JSON.stringify({ datasetVersionId }) },
      token
    ),
};
