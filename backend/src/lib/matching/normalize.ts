// Business Partner normalization (TQ-036, FR-BP-004): "Sample messy BP records normalize to
// the canonical format defined in the data dictionary."
//
// Scoping note: no customer-approved "data dictionary" artifact exists yet in this project —
// same category of gap as a Target Readiness Pack not existing until a customer provides one
// (AGENTS.md Do-Not-Do #5). Rather than block on that or silently invent one, this file *is*
// the canonical-format decision for BP names/addresses/identifiers, documented here and in
// the ADR 0002 addendum, so it's an explicit, reviewable choice rather than an assumption
// buried in matching code. Replace it with a real customer data dictionary when one exists —
// don't hard-code SAP-specific or industry-specific rules from general knowledge in its place
// (same reasoning as Do-Not-Do #5 for target packs).
//
// Two distinct outputs, deliberately not conflated:
//  - normalizeXxx() — a cleaned *display* form (whitespace/punctuation tidied, casing
//    preserved). This is what a UI would show; it never rewrites a stored business_partners
//    row on its own (see the ADR addendum — normalization output isn't persisted by this
//    sprint, only computed on demand, consistent with "AI/system never silently modifies data
//    without an approval trail" even though nothing here is AI).
//  - xxxMatchKey() — a more aggressive comparison key (uppercased, punctuation stripped,
//    common legal-entity suffixes removed) used ONLY for blocking and similarity matching in
//    lib/matching/engine.ts. Never surfaced as "the" canonical name — collapsing "Acme Corp"
//    and "ACME CORPORATION" to the same *display* value would be presumptuous rewriting of a
//    source system's own naming; collapsing them to the same *match key* is exactly the point.

const WHITESPACE_RE = /\s+/g;

// A small, representative set of legal-entity suffixes for match-key purposes — not an
// exhaustive jurisdiction-by-jurisdiction list (same "known subset, not the full table"
// tradeoff already used for currency/country codes in lib/semantics/engine.ts). Extending
// this list doesn't change the algorithm, just its recall.
const LEGAL_SUFFIXES_RE =
  /\b(INCORPORATED|CORPORATION|COMPANY|LIMITED|GMBH|LLC|LLP|INC|CORP|CO|LTD|LP|PLC|AG|SA|SRL|BV)\b/g;

function collapseWhitespace(value: string): string {
  return value.trim().replace(WHITESPACE_RE, " ");
}

/** Cleaned display form: trims and collapses whitespace, keeps the source's own casing. */
export function normalizeDisplayText(value: string | null | undefined): string {
  return collapseWhitespace(value ?? "");
}

/**
 * Aggressive comparison key for organization/person names: uppercase, strip punctuation,
 * drop common legal-entity suffixes, collapse whitespace. "Acme Corp." and "ACME
 * CORPORATION" both reduce to "ACME" — that equality is the whole point of a match key.
 */
export function nameMatchKey(name: string | null | undefined): string {
  const upper = (name ?? "").toUpperCase();
  const stripped = upper.replace(/[^\p{L}\p{N}\s]/gu, " ");
  const withoutSuffixes = stripped.replace(LEGAL_SUFFIXES_RE, " ");
  return collapseWhitespace(withoutSuffixes);
}

/** Cleaned display form for a single address line. */
export function normalizeAddressLine(line: string | null | undefined): string {
  return collapseWhitespace(line ?? "");
}

/**
 * Aggressive comparison key combining the address fields that most reliably distinguish one
 * physical location from another. Deliberately excludes line2 (suite/floor — too volatile to
 * help matching) and region (inconsistent full-name-vs-abbreviation across source systems,
 * and postal_code + country_code already narrow the location enough for blocking purposes).
 */
export function addressMatchKey(address: {
  line1?: string | null;
  city?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
}): string {
  const parts = [
    nameMatchKey(address.line1), // reuse: strips punctuation the same way street names need
    (address.city ?? "").toUpperCase().trim(),
    normalizePostalCode(address.postalCode),
    normalizeCountryCode(address.countryCode),
  ].filter((p) => p.length > 0);
  return collapseWhitespace(parts.join(" "));
}

/** ISO-3166-ish display/compare form: trim + uppercase. No validation — see semantics/engine.ts. */
export function normalizeCountryCode(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase();
}

/**
 * Trim, uppercase, and remove internal whitespace — "12345" and "12 345" (or a stray leading
 * space from a spreadsheet export) compare equal. Does not validate format; this project's
 * postal codes span many countries' conventions, which a single regex can't cover correctly.
 */
export function normalizePostalCode(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase().replace(WHITESPACE_RE, "");
}

/**
 * Comparison key for an identifier VALUE (tax ID, DUNS, external ID, ...): trim, uppercase,
 * strip whitespace/dashes/dots/slashes. "12-3456789" and "123456789" are treated as the same
 * identifier for exact-match purposes (lib/matching/engine.ts) — a documented simplification;
 * a real data dictionary might need per-identifier-type formatting rules (e.g. a VAT number's
 * check digit), which doesn't exist yet (see this file's header note).
 */
export function identifierMatchKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-./]+/g, "");
}
