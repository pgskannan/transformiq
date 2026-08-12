// Semantic field type inference v1 (TQ-026, FR-PROF-003): "Infer semantic field types."
// Heuristics-only in this sandbox — the SRS's stated operating principle is "deterministic
// controls govern; AI handles semantic ambiguity" (an embeddings/LLM-assisted path, backed
// by the Vertex AI stub from lib/vertexAI.ts, is the intended eventual second signal for
// ambiguous columns a pure regex/keyword pass can't resolve) but there is no live Vertex AI
// project available in this sandbox to call. Rather than fake that call or skip semantic
// inference entirely, this ships the deterministic half on its own, with the AI-assisted
// half tracked as a real, documented gap (see README "Known gaps") — same pattern as the
// Pub/Sub consumer gap (ADR 0002 addendum) and the Vertex AI stub itself.
//
// Design: for each candidate semantic type, a NAME hint (does the column name suggest this
// type?) and, where a reliable one exists, a VALUE validator (do the actual values look
// right?). Types with a strong value signal (email, url, phone, currency/country code) are
// checked first and don't require a name match — the values alone are convincing. Types
// without a reliable value pattern (identifier, organization/person name, address, tax id,
// currency amount) require a name-hint match plus a structural type check, since there's
// nothing else to go on. First candidate to clear its bar wins — types are checked most-
// specific/most-reliable first so a column doesn't get labeled with a weaker, more general
// type when a stronger one also fits (e.g. a "billing_email" column matches both `email`'s
// value pattern and `identifier`'s name hint; email is checked first and wins).
import type { ColumnType } from "../ingestion/detect";

export type SemanticType =
  | "email"
  | "url"
  | "phone_number"
  | "currency_code"
  | "country_code"
  | "postal_code"
  | "percentage"
  | "currency_amount"
  | "identifier"
  | "tax_id"
  | "organization_name"
  | "person_name"
  | "address_line";

const VALUE_MATCH_THRESHOLD = 0.7; // fraction of non-empty sample values that must match

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
// Digits-and-punctuation only, with enough actual digits to plausibly be a phone number
// (avoids matching things like "1-2" or a bare "-").
const PHONE_CHARS_RE = /^[+()\d\s.-]{7,20}$/;
// A small, well-known subset of ISO 4217 — this repo's target markets (SAP S/4HANA
// procurement) — not the full ~180-code table; good enough for a heuristic, not a compliance
// system. Extending this list doesn't change the algorithm, just its coverage.
const KNOWN_CURRENCY_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CNY", "INR", "AUD", "CAD", "CHF", "SGD",
  "MXN", "BRL", "ZAR", "SEK", "NOK", "DKK", "AED", "SAR", "KRW", "HKD",
]);
// Same rationale as currency codes: a representative subset, not the full ISO 3166-1 table.
const KNOWN_COUNTRY_CODES = new Set([
  "US", "GB", "DE", "FR", "IT", "ES", "NL", "BE", "CH", "AT",
  "CA", "MX", "BR", "IN", "CN", "JP", "KR", "AU", "SG", "ZA",
  "SE", "NO", "DK", "AE", "SA",
]);

interface NameHintOnly {
  nameHints: RegExp;
  allowedTypes?: ColumnType[];
}
const NAME_ONLY_CANDIDATES: Array<{ type: SemanticType; spec: NameHintOnly }> = [
  {
    type: "postal_code",
    spec: { nameHints: /zip|postal/, allowedTypes: ["string", "integer"] },
  },
  {
    type: "currency_amount",
    spec: {
      nameHints: /amount|price|cost|total|balance|credit_limit|revenue|spend|value/,
      allowedTypes: ["integer", "decimal"],
    },
  },
  {
    type: "tax_id",
    spec: { nameHints: /tax_?id|vat_?(number|id)?|ein\b/ },
  },
  {
    type: "identifier",
    spec: { nameHints: /(^|_)(id|code|number|no)($|_)|^id$/ },
  },
  {
    type: "organization_name",
    spec: {
      nameHints: /company|corp|organization|org_name|supplier_name|vendor_name|business_name/,
      allowedTypes: ["string"],
    },
  },
  {
    type: "person_name",
    spec: {
      nameHints: /contact_name|person_name|first_name|last_name|full_name|employee_name/,
      allowedTypes: ["string"],
    },
  },
  {
    type: "address_line",
    spec: { nameHints: /address|street|addr_line/, allowedTypes: ["string"] },
  },
];

export function inferSemanticType(
  columnName: string,
  inferredType: ColumnType,
  rawValues: string[]
): SemanticType | null {
  const nonEmpty = rawValues.map((v) => (v ?? "").trim()).filter((v) => v !== "");
  if (nonEmpty.length === 0) return null;
  const name = columnName.toLowerCase();

  const valueMatchRatio = (matcher: (v: string) => boolean): number =>
    nonEmpty.filter(matcher).length / nonEmpty.length;

  // 1. Strong value-pattern types, checked before any name-only type so a well-formed value
  //    (e.g. a real email address) always wins over a coincidental name match elsewhere.
  if (valueMatchRatio((v) => EMAIL_RE.test(v)) >= VALUE_MATCH_THRESHOLD) return "email";
  if (valueMatchRatio((v) => URL_RE.test(v)) >= VALUE_MATCH_THRESHOLD) return "url";
  if (
    valueMatchRatio((v) => /^[A-Z]{3}$/.test(v) && KNOWN_CURRENCY_CODES.has(v)) >= VALUE_MATCH_THRESHOLD
  ) {
    return "currency_code";
  }
  // Country code requires a name hint too — a bare 2-letter uppercase value pattern alone is
  // too ambiguous (state/province abbreviations, unit codes, etc. look identical).
  if (
    /country/.test(name) &&
    valueMatchRatio((v) => /^[A-Z]{2}$/.test(v) && KNOWN_COUNTRY_CODES.has(v)) >= VALUE_MATCH_THRESHOLD
  ) {
    return "country_code";
  }
  if (
    /phone|tel(ephone)?|fax|mobile/.test(name) &&
    valueMatchRatio((v) => PHONE_CHARS_RE.test(v) && (v.match(/\d/g) ?? []).length >= 7) >=
      VALUE_MATCH_THRESHOLD
  ) {
    return "phone_number";
  }
  if (
    /percent|_rate$|^rate$/.test(name) &&
    (inferredType === "integer" || inferredType === "decimal") &&
    valueMatchRatio((v) => {
      const n = Number(v.replace("%", ""));
      return Number.isFinite(n) && n >= 0 && n <= 100;
    }) >= VALUE_MATCH_THRESHOLD
  ) {
    return "percentage";
  }

  // 2. Name-only types: no reliable value pattern exists, so a keyword match on the column
  //    name plus a structural-type sanity check is the whole signal.
  for (const { type, spec } of NAME_ONLY_CANDIDATES) {
    if (!spec.nameHints.test(name)) continue;
    if (spec.allowedTypes && !spec.allowedTypes.includes(inferredType)) continue;
    return type;
  }

  return null;
}
