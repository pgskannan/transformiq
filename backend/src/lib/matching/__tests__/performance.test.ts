// TQ-082 (Cloud SQL indexing & pg_trgm tuning): "Fuzzy-match queries against the golden
// dataset stay within an agreed p95 latency budget."
//
// No "agreed" budget exists anywhere in this project's docs — there's no real Cloud SQL
// instance or production data volume available to agree one against (same documented gap as
// every other GCP-dependent item; see README "Known gaps"). Rather than skip this DoD or
// invent a number with no basis, this test measures the ACTUAL p95 latency of the fuzzy-match
// query (lib/matching/engine.ts's findFuzzyMatchCandidates) against a seeded fixture set,
// locally, on the GIN trigram index from db/migrations/0011_entity_resolution.sql — and pins
// that measured number as the budget going forward, the same "pin what was actually measured,
// document the scope it was measured at" approach used for the fuzzy-match similarity
// threshold. See docs/adr/0002-gcp-architecture-and-tenancy.md's TQ-082 addendum for the
// measured baseline and its explicit "not validated at production/Cloud SQL scale" caveat.
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../../../app";
import { closeDb, withTenant } from "../../db";
import { makeTenant, tokenFor } from "../../../test-utils/helpers";
import { findFuzzyMatchCandidates } from "../engine";

const app = createApp();

// A representative mid-size project: enough rows that a full O(n^2) sequential scan would be
// noticeably slow, small enough to run in a unit-test time budget. A handful of genuine
// near-duplicate clusters are seeded in so the query does real work, not just index misses.
const SEED_COUNT = 300;
const QUERY_ITERATIONS = 20;
// Measured empirically on this sandbox's local Postgres 16 (see the ADR addendum for the
// actual numbers from the run this threshold was set against). Generous headroom above the
// measured p95 so ordinary CI machine variance doesn't make this test flaky — the point is
// catching a real regression (e.g. the trigram index silently not being used), not chasing a
// tight SLA number nothing has agreed to yet.
const P95_BUDGET_MS = 500;

const NAME_WORDS = [
  "Acme", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Hooli", "Soylent", "Massive",
  "Cyberdyne", "Vandelay", "Wonka", "Oscorp", "Pied Piper", "Duff", "Prestige", "Dunder",
  "Sirius", "Contoso", "Fabrikam",
];
const NAME_SUFFIXES = ["Corp", "Corporation", "Industries", "Holdings", "Group", "LLC", "Inc", "Partners", "Systems", "Solutions"];

// 20 words x 10 suffixes = 200 combinations before any repeat; with SEED_COUNT=300 rows that
// means most rows are trigram-unrelated to each other (the realistic common case — an index
// should let Postgres skip almost all of them cheaply) with a modest number of genuine
// near-duplicate pairs mixed in (the case the index needs to still find correctly), rather
// than one artificial mega-cluster of near-identical names that would make every query touch
// nearly the whole table regardless of indexing.
function randomCompanyName(i: number): string {
  const word = NAME_WORDS[i % NAME_WORDS.length];
  const suffix = NAME_SUFFIXES[Math.floor(i / NAME_WORDS.length) % NAME_SUFFIXES.length];
  return `${word} ${suffix} ${i}`;
}

async function createProject(token: string): Promise<string> {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Perf Fixture", domain: "Direct Procurement", sourceSystem: "Legacy ERP", targetSystem: "SAP S/4HANA" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("Fuzzy-match query latency (TQ-082)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it(`p95 latency across ${QUERY_ITERATIONS} runs against ${SEED_COUNT} seeded BPs stays under ${P95_BUDGET_MS}ms locally`, async () => {
    const tenantId = await makeTenant(app, `Perf Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    // Direct batch insert (not through the HTTP API) — this test measures query latency, not
    // ingestion throughput, and 300 individual HTTP round trips would dominate the timing.
    await withTenant(tenantId, async (trx) => {
      const rows = Array.from({ length: SEED_COUNT }, (_, i) => ({
        id: randomUUID(),
        tenant_id: tenantId,
        project_id: projectId,
        bp_type: "organization",
        primary_name: randomCompanyName(i),
        updated_at: new Date(),
      }));
      // Kysely's insertInto(...).values(array) batches into one statement.
      await trx.insertInto("business_partners").values(rows).execute();
    });

    const timings: number[] = [];
    await withTenant(tenantId, async (trx) => {
      for (let i = 0; i < QUERY_ITERATIONS; i++) {
        const start = performance.now();
        await findFuzzyMatchCandidates(trx, tenantId, projectId);
        timings.push(performance.now() - start);
      }
    });

    timings.sort((a, b) => a - b);
    const p95Index = Math.floor(timings.length * 0.95);
    const p95 = timings[Math.min(p95Index, timings.length - 1)];

    // eslint-disable-next-line no-console
    console.log(`[TQ-082] fuzzy-match query latency over ${QUERY_ITERATIONS} runs (ms): ${timings.map((t) => t.toFixed(1)).join(", ")} — p95=${p95.toFixed(1)}ms`);

    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 30000);
});
