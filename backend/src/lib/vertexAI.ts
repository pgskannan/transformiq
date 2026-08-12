// Vertex AI client stub (TQ-079 spike). No live GCP project was available to verify real
// quota/access from this sandbox — this wraps the intended call shape so the AI routing
// service (Sprint 5, TQ-040) has a stable interface to build against, and documents exactly
// what needs to happen before it's real.
//
// AGENTS.md §1.6: route every AI-assisted decision through deterministic → algorithm/
// embedding → LLM, in that order, and only call this for genuine semantic ambiguity.

export interface EmbedRequest {
  texts: string[];
  model?: string; // defaults to a configured embedding model once one is chosen
}

export interface EmbedResponse {
  embeddings: number[][];
  model: string;
}

export interface GenerateRequest {
  prompt: string;
  model?: string;
  maxOutputTokens?: number;
}

export interface GenerateResponse {
  text: string;
  model: string;
  // Fields required by FR-AI-002/003: every AI call must be able to report what it cost and
  // which config produced the result, for AuditEvent + AI cost metering (Sprint 8).
  promptTokens?: number;
  outputTokens?: number;
}

const NOT_CONFIGURED =
  "Vertex AI is not configured. Set GCP_PROJECT_ID and VERTEX_AI_LOCATION, and confirm API " +
  "access/quota per the Sprint 1 spike (TQ-079) before calling this in a real environment.";

export async function embed(_req: EmbedRequest): Promise<EmbedResponse> {
  if (!process.env.GCP_PROJECT_ID) {
    throw new Error(NOT_CONFIGURED);
  }
  // TODO(Sprint 4/5, TQ-032/TQ-039): call Vertex AI's embedding endpoint via
  // @google-cloud/vertexai (or @google-cloud/aiplatform) once a project + model is chosen.
  throw new Error("embed() is not yet implemented — see TQ-039.");
}

export async function generate(_req: GenerateRequest): Promise<GenerateResponse> {
  if (!process.env.GCP_PROJECT_ID) {
    throw new Error(NOT_CONFIGURED);
  }
  // TODO(Sprint 5, TQ-040): call Vertex AI's generateContent endpoint. Must go through the
  // deterministic → algorithm/embedding → LLM router, never called directly from a route.
  throw new Error("generate() is not yet implemented — see TQ-040.");
}
