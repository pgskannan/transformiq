import { computeProjectQualityScore } from "../projectQualityScore";

describe("computeProjectQualityScore", () => {
  it("averages quality scores across profiled datasets only", () => {
    const result = computeProjectQualityScore([
      { datasetId: "a", datasetName: "A", latestVersionId: "v1", versionNumber: 1, qualityScore: 0.8 },
      { datasetId: "b", datasetName: "B", latestVersionId: "v2", versionNumber: 1, qualityScore: 0.6 },
    ]);
    expect(result.datasetCount).toBe(2);
    expect(result.profiledDatasetCount).toBe(2);
    expect(result.overallQualityScore).toBeCloseTo(0.7, 5);
  });

  it("excludes unprofiled datasets from the average rather than treating them as 0", () => {
    const result = computeProjectQualityScore([
      { datasetId: "a", datasetName: "A", latestVersionId: "v1", versionNumber: 1, qualityScore: 0.9 },
      { datasetId: "b", datasetName: "B", latestVersionId: null, versionNumber: null, qualityScore: null },
    ]);
    expect(result.datasetCount).toBe(2);
    expect(result.profiledDatasetCount).toBe(1);
    // If the unprofiled dataset were treated as 0, this would be 0.45, not 0.9.
    expect(result.overallQualityScore).toBeCloseTo(0.9, 5);
  });

  it("returns null overallQualityScore (not 0 or NaN) when no dataset has been profiled yet", () => {
    const result = computeProjectQualityScore([
      { datasetId: "a", datasetName: "A", latestVersionId: null, versionNumber: null, qualityScore: null },
    ]);
    expect(result.profiledDatasetCount).toBe(0);
    expect(result.overallQualityScore).toBeNull();
  });

  it("returns null overallQualityScore for a project with zero datasets, not an error", () => {
    const result = computeProjectQualityScore([]);
    expect(result.datasetCount).toBe(0);
    expect(result.overallQualityScore).toBeNull();
  });
});
