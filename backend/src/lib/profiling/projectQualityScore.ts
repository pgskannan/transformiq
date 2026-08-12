// Project-level quality score rollup (TQ-027, FR-PROF-004). Field-level quality_score
// (lib/profiling/engine.ts) and dataset-(version-)level overall_quality_score already exist
// from TQ-024 — this adds the third rollup tier FR-PROF-004 asks for: a single score across
// every dataset in a project.
//
// Scope note (deliberate, not an oversight): FR-PROF-004's own DoD wording is "quality score
// recomputes correctly after a fixture is remediated" — but remediation (the feature that
// lets a user fix flagged issues in place) doesn't exist until a much later sprint. Rather
// than block this ticket on a feature that isn't built yet, "remediated" is interpreted
// pragmatically as *any* change to the underlying data that produces a new, cleaner
// dataset_version — which is exactly how this system already represents "the data changed"
// (immutable-raw-per-version, see ADR 0002). The integration test for this
// (src/__tests__/qualityScore.test.ts) ingests a deliberately dirty CSV, then a cleaner CSV
// as a second version of the *same* dataset, and proves: (a) the new version's own score is
// higher, (b) the project rollup reflects the latest version's score, not a stale one, and
// (c) re-triggering profiling on an unchanged version reproduces the identical score
// (recompute is deterministic/idempotent, not just "changes when re-run"). When real
// remediation ships, this is still the correct rollup — nothing here assumes it.
//
// A dataset with no profiled version yet is excluded from the average (not counted as 0) —
// "hasn't been profiled" and "profiled at 0 quality" are different facts, and conflating them
// would make the project score meaningless while any dataset is still mid-ingestion.
export interface DatasetLatestQualityScore {
  datasetId: string;
  datasetName: string;
  latestVersionId: string | null;
  versionNumber: number | null;
  qualityScore: number | null;
}

export interface ProjectQualityScoreResult {
  datasetCount: number;
  profiledDatasetCount: number;
  overallQualityScore: number | null;
  datasets: DatasetLatestQualityScore[];
}

export function computeProjectQualityScore(
  datasets: DatasetLatestQualityScore[]
): ProjectQualityScoreResult {
  const profiled = datasets.filter((d) => d.qualityScore !== null);
  const overallQualityScore =
    profiled.length === 0
      ? null
      : profiled.reduce((sum, d) => sum + (d.qualityScore as number), 0) / profiled.length;

  return {
    datasetCount: datasets.length,
    profiledDatasetCount: profiled.length,
    overallQualityScore,
    datasets,
  };
}
