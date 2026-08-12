// Entity resolution matching engine (TQ-031/032, FR-DUP-001/FR-DUP-002): exact matching on
// configured identifiers, and fuzzy matching on name/address similarity via Postgres pg_trgm.
//
// Exact matching runs in application code, reusing lib/matching/normalize.ts's
// identifierMatchKey() as the single source of truth for "what counts as the same identifier
// value" — deliberately NOT reimplemented as a second, parallel SQL regex that could drift
// out of sync with the TS version. Identifier volume per project is small (a handful of rows
// per BP), so pulling them into app code costs nothing at this scale.
//
// Fuzzy matching runs as SQL against Postgres directly, NOT reimplemented in JS: pg_trgm's
// trigram-similarity algorithm is what actually needs to scale (TQ-082's indexing target),
// and a hand-rolled JS approximation would both be slower and could disagree with what the
// same query returns once run against a real, larger Cloud SQL instance. See
// db/migrations/0011_entity_resolution.sql for the GIN trigram index this query depends on,
// and docs/adr/0002-gcp-architecture-and-tenancy.md's TQ-032 addendum for the empirical
// similarity scores the 0.5 threshold below was actually chosen against.

import { sql, type Kysely } from "kysely";
import type { DB } from "../../../db/types";
import { identifierMatchKey } from "./normalize";
import { computeMatchConfidence, type MatchEvidence, type MatchSignal } from "./confidence";

export interface MatchCandidate {
  /** Always the lexicographically smaller of the two BP ids — see 0011's canonical-order CHECK. */
  businessPartnerId: string;
  candidateBusinessPartnerId: string;
  matchMethod: "exact" | "fuzzy";
  evidence: MatchEvidence;
  confidence: number;
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** FR-DUP-001: two BPs in the same project sharing a configured identifier (type + normalized value). */
export async function findExactMatchCandidates(
  trx: Kysely<DB>,
  projectId: string
): Promise<MatchCandidate[]> {
  const rows = await trx
    .selectFrom("bp_identifiers as ident")
    .innerJoin("business_partners as bp", "bp.id", "ident.business_partner_id")
    .select(["ident.business_partner_id", "ident.identifier_type", "ident.identifier_value"])
    .where("bp.project_id", "=", projectId)
    .execute();

  // Group by (identifier_type, normalized value) — every group of >=2 distinct BPs sharing a
  // key is a mesh of pairwise exact-match candidates.
  const groups = new Map<string, { businessPartnerId: string; identifierType: string; identifierValue: string }[]>();
  for (const row of rows) {
    const normalized = identifierMatchKey(row.identifier_value);
    // An all-punctuation/whitespace identifier value normalizes to "" — not a meaningful
    // match key, so those rows are excluded rather than spuriously grouped together.
    if (normalized === "") continue;
    const key = `${row.identifier_type}::${normalized}`;
    const list = groups.get(key) ?? [];
    list.push({
      businessPartnerId: row.business_partner_id,
      identifierType: row.identifier_type,
      identifierValue: row.identifier_value,
    });
    groups.set(key, list);
  }

  const candidates = new Map<string, MatchCandidate>(); // dedupe pair -> best evidence
  for (const members of groups.values()) {
    const distinctBpIds = [...new Set(members.map((m) => m.businessPartnerId))];
    if (distinctBpIds.length < 2) continue;
    for (let i = 0; i < distinctBpIds.length; i++) {
      for (let j = i + 1; j < distinctBpIds.length; j++) {
        const [businessPartnerId, candidateBusinessPartnerId] = canonicalPair(distinctBpIds[i], distinctBpIds[j]);
        const member = members.find((m) => m.businessPartnerId === distinctBpIds[i])!;
        const signal: MatchSignal = {
          type: "identifier_exact",
          detail: `Shared ${member.identifierType} identifier "${member.identifierValue}"`,
          score: 1,
        };
        const pairKey = `${businessPartnerId}::${candidateBusinessPartnerId}`;
        const evidence: MatchEvidence = { signals: [signal] };
        candidates.set(pairKey, {
          businessPartnerId,
          candidateBusinessPartnerId,
          matchMethod: "exact",
          evidence,
          confidence: computeMatchConfidence(evidence),
        });
      }
    }
  }
  return [...candidates.values()];
}

// Empirically chosen against docs/adr/0002-gcp-architecture-and-tenancy.md's TQ-032 addendum
// table — cleanly separates real name variants ("Acme Corp" / "Acme Corporation" = 0.5) from
// coincidentally-similar-but-distinct company names ("Acme Corp" / "Ajax Corp" = 0.43).
export const FUZZY_NAME_SIMILARITY_THRESHOLD = 0.5;

interface FuzzyMatchRow {
  bp_a: string;
  bp_b: string;
  name_similarity: number;
  address_similarity: number | null;
}

/** FR-DUP-002: name/address similarity via pg_trgm, blocked by the trigram index itself. */
export async function findFuzzyMatchCandidates(
  trx: Kysely<DB>,
  tenantId: string,
  projectId: string,
  threshold: number = FUZZY_NAME_SIMILARITY_THRESHOLD
): Promise<MatchCandidate[]> {
  // SET LOCAL (not a bare SET) so this only affects the current transaction — withTenant()
  // callers share a pooled connection across requests, and a session-scoped GUC change would
  // leak into whatever runs next on that connection.
  await sql`select set_config('pg_trgm.similarity_threshold', ${threshold.toString()}, true)`.execute(trx);

  const result = await sql<FuzzyMatchRow>`
    with primary_address as (
      select distinct on (business_partner_id)
        business_partner_id,
        concat_ws(' ', line1, city, postal_code, country_code) as addr_text
      from bp_addresses
      where tenant_id = ${tenantId}
      order by business_partner_id, is_primary desc, created_at asc
    )
    select
      a.id as bp_a,
      b.id as bp_b,
      similarity(upper(a.primary_name), upper(b.primary_name)) as name_similarity,
      case
        when pa.addr_text is not null and pa.addr_text != '' and pb.addr_text is not null and pb.addr_text != ''
        then similarity(upper(pa.addr_text), upper(pb.addr_text))
        else null
      end as address_similarity
    from business_partners a
    join business_partners b
      on a.id < b.id and a.project_id = b.project_id and a.tenant_id = b.tenant_id
    left join primary_address pa on pa.business_partner_id = a.id
    left join primary_address pb on pb.business_partner_id = b.id
    where a.project_id = ${projectId}
      and a.tenant_id = ${tenantId}
      and upper(a.primary_name) % upper(b.primary_name)
      and similarity(upper(a.primary_name), upper(b.primary_name)) >= ${threshold}
  `.execute(trx);

  return result.rows.map((row) => {
    const signals: MatchSignal[] = [
      {
        type: "name_similarity",
        detail: `Name trigram similarity ${row.name_similarity.toFixed(2)}`,
        score: Number(row.name_similarity),
      },
    ];
    if (row.address_similarity !== null) {
      signals.push({
        type: "address_similarity",
        detail: `Primary-address trigram similarity ${row.address_similarity.toFixed(2)}`,
        score: Number(row.address_similarity),
      });
    }
    const evidence: MatchEvidence = { signals };
    return {
      businessPartnerId: row.bp_a,
      candidateBusinessPartnerId: row.bp_b,
      matchMethod: "fuzzy" as const,
      evidence,
      confidence: computeMatchConfidence(evidence),
    };
  });
}

/**
 * Runs both detectors and merges results: a pair found by both keeps the exact-match
 * evidence (confidence 1.0 always wins over any fuzzy score for the same pair — FR-DUP-001
 * is checked first in this list deliberately, matching the pipeline order in the SRS).
 */
export async function findAllMatchCandidates(
  trx: Kysely<DB>,
  tenantId: string,
  projectId: string
): Promise<MatchCandidate[]> {
  const [exact, fuzzy] = await Promise.all([
    findExactMatchCandidates(trx, projectId),
    findFuzzyMatchCandidates(trx, tenantId, projectId),
  ]);

  const byPair = new Map<string, MatchCandidate>();
  for (const candidate of [...fuzzy, ...exact]) {
    // fuzzy inserted first, exact second — Map.set() overwrites, so exact always wins when
    // both detectors find the same pair.
    const pairKey = `${candidate.businessPartnerId}::${candidate.candidateBusinessPartnerId}`;
    byPair.set(pairKey, candidate);
  }
  return [...byPair.values()];
}
