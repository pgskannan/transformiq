// TQ-013/TQ-014 acceptance: uploading a file a second time creates a new object version;
// original bytes are provably unmodified (checksum). Exercised through the real HTTP API
// against real Postgres + real local filesystem storage — see src/lib/objectStorage.ts.
import { chmod, readFile, stat, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { closeDb } from "../lib/db";
import { getObjectStorage } from "../lib/objectStorage";
import { makeTenant, tokenFor } from "../test-utils/helpers";

const app = createApp();

async function createProject(token: string) {
  const res = await request(app)
    .post("/v1/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Dataset Test Project",
      domain: "Direct Procurement",
      sourceSystem: "Legacy ERP",
      targetSystem: "SAP S/4HANA",
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("dataset ingestion + immutable storage", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("uploading twice creates two versions with distinct, checksum-verifiable content", async () => {
    const tenantId = await makeTenant(app, `Dataset Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const v1Content = Buffer.from("supplier_id,name\n1,Acme Corp\n").toString("base64");
    const v1 = await request(app)
      .post(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetName: "suppliers", filename: "suppliers.csv", contentBase64: v1Content });
    expect(v1.status).toBe(201);
    expect(v1.body.version.version_number).toBe(1);
    expect(v1.body.version.parent_version_id).toBeNull();

    const v2Content = Buffer.from("supplier_id,name\n1,Acme Corp\n2,Globex\n").toString("base64");
    const v2 = await request(app)
      .post(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetName: "suppliers", filename: "suppliers.csv", contentBase64: v2Content });
    expect(v2.status).toBe(201);
    expect(v2.body.version.version_number).toBe(2);
    expect(v2.body.version.parent_version_id).toBe(v1.body.version.id);
    expect(v2.body.version.source_artifact_ref).not.toBe(v1.body.version.source_artifact_ref);

    // Checksums are independently verifiable against the actual stored bytes.
    const expectedV1Checksum = createHash("sha256")
      .update(Buffer.from(v1Content, "base64"))
      .digest("hex");
    expect(v1.body.version.source_artifact_checksum).toBe(expectedV1Checksum);

    const storedV1 = await getObjectStorage().getObject(v1.body.version.source_artifact_ref);
    expect(storedV1.toString("utf8")).toBe("supplier_id,name\n1,Acme Corp\n");

    // Version history is queryable and both versions coexist (v1 was never overwritten).
    const versions = await request(app)
      .get(`/v1/datasets/${v1.body.dataset.id}/versions`)
      .set("Authorization", `Bearer ${token}`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toHaveLength(2);
  });

  it("the stored raw file is chmod'd read-only on disk", async () => {
    const tenantId = await makeTenant(app, `Immutability Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);

    const content = Buffer.from("plant_id,name\n1,Plant A\n").toString("base64");
    const res = await request(app)
      .post(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetName: "plants", filename: "plants.csv", contentBase64: content });
    expect(res.status).toBe(201);

    const ref: string = res.body.version.source_artifact_ref;
    const localPath = ref.replace("local://", `${process.cwd()}/.data/raw/`);

    const mode = (await stat(localPath)).mode & 0o777;
    expect(mode).toBe(0o444);

    // Honest caveat, proven rather than assumed: chmod 0o444 only stops *unprivileged*
    // writers. A process running as root (as this test suite does, in the sandbox this
    // scaffold was built in) bypasses Unix file permissions entirely — verified directly
    // below rather than asserted. This is why production immutability is NOT this chmod
    // call; it's GCS bucket versioning + a retention lock (infra/terraform/modules/storage),
    // which no identity — root included — can casually bypass. See objectStorage.ts.
    if (process.getuid && process.getuid() === 0) {
      await writeFile(localPath, "tampered content"); // succeeds — this IS the point being proven
      const tampered = await readFile(localPath, "utf8");
      expect(tampered).toBe("tampered content");
      // Restore for repeatability of this test file across runs.
      await writeFile(localPath, "plant_id,name\n1,Plant A\n");
      await chmod(localPath, 0o444);
    } else {
      await expect(writeFile(localPath, "tampered content")).rejects.toThrow(/EACCES|permission/i);
    }
  });

  it("re-uploading byte-identical content is idempotent (same ref, no duplicate version bloat)", async () => {
    const tenantId = await makeTenant(app, `Idempotent Tenant ${randomUUID()}`);
    const token = tokenFor(tenantId);
    const projectId = await createProject(token);
    const content = Buffer.from("category_id,name\n1,Office Supplies\n").toString("base64");

    const first = await request(app)
      .post(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetName: "categories", filename: "categories.csv", contentBase64: content });

    const second = await request(app)
      .post(`/v1/projects/${projectId}/datasets`)
      .set("Authorization", `Bearer ${token}`)
      .send({ datasetName: "categories", filename: "categories.csv", contentBase64: content });

    // Two dataset_versions rows (each upload IS a new version, by design — TQ-014), but
    // both point at the same immutable object in storage since the bytes are identical.
    expect(first.body.version.source_artifact_ref).toBe(second.body.version.source_artifact_ref);
    expect(first.body.version.source_artifact_checksum).toBe(
      second.body.version.source_artifact_checksum
    );
  });
});
