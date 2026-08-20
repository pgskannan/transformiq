// Gemini client (TQ-079 spike, made real in Sprint 5 / TQ-039-040 — hackathon slice, see
// docs/adr/0003-gemini-genkit-integration.md).
//
// AGENTS.md §1.6: route every AI-assisted decision through deterministic -> algorithm/
// embedding -> LLM, in that order, and only call this for genuine semantic ambiguity a
// cheaper method could not resolve (Do-Not-Do rule #17). Callers (see
// lib/semantics/aiResolver.ts) are responsible for only reaching this module once the
// deterministic pass has already failed.
//
// Uses Genkit (https://genkit.dev) — a Google Agent Framework — with the
// `@genkit-ai/google-genai` plugin's `googleAI` initializer, which calls Gemini through the
// public Gemini API using an API key (GEMINI_API_KEY, read via lib/secrets.ts so it is never
// hard-coded and comes from Secret Manager in a real GCP deployment — AGENTS.md Do-Not-Do
// rule #9). This file is the ONLY place that should ever construct a Genkit/Gemini client,
// same "one construction point" pattern as lib/objectStorage.ts and lib/secrets.ts.
//
// This previously shipped as a stub whose generate()/embed() always threw — no live GCP
// project or internet access to any Google endpoint was available while the Sprint 1-4
// scaffold was built (see README "Known gaps"). It is real starting with this change: it
// makes an actual Gemini API call when GEMINI_API_KEY is configured, and still fails loudly
// (never silently) when it is not, so a missing key is caught in dev/CI rather than at 3am
// in prod.

import { getSecret } from "./secrets";

export interface GenerateRequest {
  prompt: string;
  model?: string;
  maxOutputTokens?: number;
  /** Optional Zod schema for structured/constrained output. Strongly preferred over parsing
   *  free text for anything a downstream system will branch on (AGENTS.md Do-Not-Do rule #4
   *  — never treat an unvalidated model guess as authoritative). */
  outputSchema?: unknown;
}

export interface GenerateResponse {
  text: string;
  /** Present when outputSchema was provided and the model's response validated against it. */
  output?: unknown;
  model: string;
  // FR-AI-002/003: every AI call must be able to report what it cost and which config
  // produced the result, for AuditEvent + AI cost metering (Sprint 8).
  promptTokens?: number;
  outputTokens?: number;
}

export interface EmbedRequest {
  texts: string[];
  model?: string;
}

export interface EmbedResponse {
  embeddings: number[][];
  model: string;
}

const DEFAULT_MODEL = "gemini-3.6-flash"; // stable, Gemini 3.5+, Flash tier — matches the AI
// routing principle of picking the least expensive method that resolves the case (AGENTS.md
// §1.6): this module is only ever reached for genuine ambiguity, not bulk work, so Flash's
// lower cost/latency is preferred over Pro unless a caller overrides it.
const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";

// Lazy singleton, same pattern as lib/objectStorage.ts's GcsObjectStorage and
// lib/secrets.ts's SecretManagerServiceClient — constructing a Genkit instance touches the
// network-adjacent SDK, so it should not happen at module-import time (breaks tests/CI that
// never call this module).
let genkitInstance: import("genkit").Genkit | null = null;

async function getGenkit(): Promise<import("genkit").Genkit> {
  if (genkitInstance) return genkitInstance;

  const apiKey = await getSecret("GEMINI_API_KEY");

  const { genkit } = await import("genkit");
  const { googleAI } = await import("@genkit-ai/google-genai");

  genkitInstance = genkit({ plugins: [googleAI({ apiKey })] });
  return genkitInstance;
}

export async function generate(req: GenerateRequest): Promise<GenerateResponse> {
  const ai = await getGenkit();
  const { googleAI } = await import("@genkit-ai/google-genai");
  const model = req.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;

  const response = await ai.generate({
    model: googleAI.model(model),
    prompt: req.prompt,
    config: req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : undefined,
    output: req.outputSchema ? { schema: req.outputSchema as never } : undefined,
  });

  return {
    text: response.text,
    output: req.outputSchema ? response.output : undefined,
    model,
    promptTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  };
}

export async function embed(req: EmbedRequest): Promise<EmbedResponse> {
  const ai = await getGenkit();
  const { googleAI } = await import("@genkit-ai/google-genai");
  const model = req.model ?? DEFAULT_EMBEDDING_MODEL;

  const results = await Promise.all(
    req.texts.map((content) =>
      ai.embed({ embedder: googleAI.embedder(model as `gemini-embedding-${string}`), content })
    )
  );

  return {
    embeddings: results.map((r) => (Array.isArray(r) ? r[0]?.embedding ?? [] : [])),
    model,
  };
}
