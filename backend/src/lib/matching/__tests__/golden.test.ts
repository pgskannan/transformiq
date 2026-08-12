// TQ-030 (AGENTS.md §5 / SRS §24): "Golden dataset harness v1 (BP/Supplier fixtures with
// known-correct outcomes). Regression suite runs against golden fixtures in CI and fails on
// drift." This IS that harness — it runs as part of `npm test`, which .github/workflows/ci.yml
// already runs on every push/PR, so "runs in CI" doesn't need a separate CI job.
//
// GOLDEN_BUSINESS_PARTNERS below is a pinned fixture set with known-correct match outcomes,
// split into positive pairs (must be found as candidates) and negative pairs (must NOT be —
// precision matters as much as recall for a duplicate-detection system, since a false match
// is a steward's wasted review time or worse, a wrongful merge). The fuzzy-match expectations
// are not guesses — they're pinned against the actual pg_trgm similarity() scores this
// project measured empirically before choosing FUZZY_NAME_SIMILARITY_THRESHOLD (see
// lib/matching/engine.ts and the ADR 0002 TQ-032 addendum for that table). If a future change
// to the threshold, the normalization rules, or the matching query shifts any of these
// outcomes, this test fails — that's the "fails on drift" requirement, made concrete.
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../../../app";
import { closeDb } from "../../db";
import { makeTenant, tokenFor } from "../../../test-utils/helpers";

const app = createApp();

interface GoldenBp {
  key: string;
  primaryName: string;
  identifiers?: { identifierType: string; identifierValue: string }[];
}

// Real companies never appear here — every name is a well-known placeholder already used
// elsewhere in this repo's fixtures (Acme/Globex/Initech/Wayne/Stark/Umbrella), chosen so a
// reader instantly recognizes these as synthetic test data, not real BP records.
const GOLDEN_BUSINESS_PARTNERS: GoldenBp[] = [
  { key: "acme_a", primaryName: "Acme Corp", identifiers: [{ identifierType: "tax_id", identifierValue: "12-3456789" }] },
  // Same real-world tax ID as acme_a once normalized (dash stripped) — an exact-match pair,
  // AND its name is a fuzzy variant of acme_a's too (see the ADR table: similarity 0.5).
  { key: "acme_b", primaryName: "Acme Corporation", identifiers: [{ identifierType: "tax_id", identifierValue: "123456789" }] },
  { key: "globex_a", primaryName: "Globex Corporation", identifiers: [{ identifierType: "tax_id", identifierValue: "98-7654321" }] },
  // A DIFFERENT tax ID from globex_a — only the fuzzy name signal should catch this pair
  // (similarity 0.55 per the ADR table), proving fuzzy matching works independently of exact.
  { key: "globex_b", primaryName: "Globex Corp", identifiers: [{ identifierType: "tax_id", identifierValue: "11-1111111" }] },
  { key: "wayne_a", primaryName: "Wayne Enterprises" },
  // A plausible data-entry typo of wayne_a (similarity 0.71 per the ADR table).
  { key: "wayne_b", primaryName: "Wayne Enterprizes" },
  // Deliberately similar-SOUNDING but genuinely distinct company — must NOT match acme_a/b
  // (similarity 0.43, below threshold — this is the negative fixture that keeps the
  // threshold honest, not just "high enough to catch everything").
  { key: "ajax", primaryName: "Ajax Corp" },
  { key: "stark", primaryName: "Stark Industries" },
  // Unrelated to stark; similarity 0 per the ADR table.
  { key: "umbrella", primaryName: "Umbrella Corp" },
];

// [key, key] pairs, unordered — every one of these MUST appear as a candidate after running
// the matcher, with the given expected primary detection method.
const EXPECTED_POSITIVE_PAIRS: [string, string, "exact" | "fuzzy"][] = [
  ["acme_a", "acme_b", "exact"], // exact identifier wins over the co-occurring fuzzy name signal
  ["globex_a", "globex_b", "fuzzy"],
  ["wayne_a", "wayne_b", "fuzzy"],
];

// [key, key] pairs that MUST NOT appear as a candidate at all.
const EXPECTED_NEGATIVE_PAIRS: [string, string][] = [
  ["acme_a", "ajax"],
  ["acme_b", "ajax"],
  ["stark", "umbrella"],
  ["wayne_a", "stark"],
];

async function createProject(token: string): Promise<string> {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Golden Fixtures", domain: "Direct Procurement", sourceSystem: "Legacy ERP", targetSystem: "SAP S/4HANA" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("Entity resolution golden dataset harness (TQ-030)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("finds every pinned positive pair and none of the pinned negative pairs", async () => {
    const tenantId = await makeTenant(app, `Golden Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const idByKey = new Map<string, string>();
    for (const bp of GOLDEN_BUSINESS_PARTNERS) {
      const created = await request(app)
        .post(`/v1/projects/${projectId}/business-partners`)
        .set("Authorization", `Bearer ${token}`)
        .send({ primaryName: bp.primaryName, bpType: "organization" });
      expect(created.status).toBe(201);
      idByKey.set(bp.key, created.body.id);

      for (const identifier of bp.identifiers ?? []) {
        const identRes = await request(app)
          .post(`/v1/business-partners/${created.body.id}/identifiers`)
          .set("Authorization", `Bearer ${token}`)
          .send(identifier);
        expect(identRes.status).toBe(201);
      }
    }

    const runRes = await request(app)
      .post(`/v1/projects/${projectId}/entity-matches/run`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(runRes.status).toBe(200);

    const listRes = await request(app)
      .get(`/v1/projects/${projectId}/entity-matches`)
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const matches = listRes.body.matches as {
      business_partner_id: string;
      candidate_business_partner_id: string;
      match_method: string;
    }[];

    const foundPairs = new Set(
      matches.map((m) => [m.business_partner_id, m.candidate_business_partner_id].sort().join("::"))
    );
    const methodByPair = new Map(
      matches.map((m) => [[m.business_partner_id, m.candidate_business_partner_id].sort().join("::"), m.match_method])
    );

    for (const [keyA, keyB, expectedMethod] of EXPECTED_POSITIVE_PAIRS) {
      const pairId = [idByKey.get(keyA)!, idByKey.get(keyB)!].sort().join("::");
      expect(foundPairs.has(pairId)).toBe(true);
      expect(methodByPair.get(pairId)).toBe(expectedMethod);
    }

    for (const [keyA, keyB] of EXPECTED_NEGATIVE_PAIRS) {
      const pairId = [idByKey.get(keyA)!, idByKey.get(keyB)!].sort().join("::");
      expect(foundPairs.has(pairId)).toBe(false);
    }
  });
});
