// Immutable raw-artifact storage (TQ-013, FR-PROJ-002/003). Every ingested source file goes
// through putImmutable() and is never modified afterward — see AGENTS.md §4.1.
//
// Two backends, same interface:
//  - local filesystem (dev/test, used whenever GCP_PROJECT_ID is unset): content-addressed
//    by SHA-256, and the file is chmod'd read-only (0o444) after write. That chmod is a
//    guard against accidental overwrite by an unprivileged process ONLY — a process running
//    as root (true of the sandbox this scaffold was built and tested in) bypasses Unix file
//    permissions entirely, proven directly rather than assumed in
//    src/__tests__/datasets.test.ts. Do not rely on this for real immutability.
//  - GCS (real deployments): bucket versioning + retention lock (see
//    infra/terraform/modules/storage) enforce immutability at the infrastructure level,
//    which is the actual guarantee — this backend hasn't been exercised against a real
//    bucket (no GCP project was available while building this).

import { createHash } from "crypto";
import { existsSync } from "fs";
import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

export interface PutImmutableInput {
  tenantId: string;
  filename: string;
  data: Buffer;
}

export interface PutImmutableResult {
  ref: string; // opaque pointer — pass back to getObject(), don't parse it
  checksum: string; // sha256 hex, independently verifiable
  bytes: number;
}

export interface ObjectStorage {
  putImmutable(input: PutImmutableInput): Promise<PutImmutableResult>;
  getObject(ref: string): Promise<Buffer>;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function safeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly baseDir: string) {}

  async putImmutable({ tenantId, filename, data }: PutImmutableInput): Promise<PutImmutableResult> {
    const checksum = sha256Hex(data);
    // Content-addressed path: re-uploading byte-identical content is idempotent and lands
    // on the same ref, which is consistent with "immutable" — there is nothing to overwrite.
    const relPath = join(tenantId, `${checksum}-${safeFilename(filename)}`);
    const fullPath = join(this.baseDir, relPath);

    if (!existsSync(fullPath)) {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, data, { mode: 0o444 });
      // writeFile's mode option is only applied on file creation on some platforms; chmod
      // explicitly so this holds regardless.
      await chmod(fullPath, 0o444);
    }

    return { ref: `local://${relPath}`, checksum, bytes: data.byteLength };
  }

  async getObject(ref: string): Promise<Buffer> {
    if (!ref.startsWith("local://")) {
      throw new Error(`Not a local ref: ${ref}`);
    }
    const relPath = ref.slice("local://".length);
    return readFile(join(this.baseDir, relPath));
  }
}

class GcsObjectStorage implements ObjectStorage {
  constructor(
    private readonly projectId: string,
    private readonly bucketName: string
  ) {}

  private async getBucket() {
    // Lazy import, same pattern as src/lib/secrets.ts — @google-cloud/storage is a real
    // dependency (see package.json) but this path has never run against a real bucket.
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage({ projectId: this.projectId });
    return storage.bucket(this.bucketName);
  }

  async putImmutable({ tenantId, filename, data }: PutImmutableInput): Promise<PutImmutableResult> {
    const checksum = sha256Hex(data);
    const objectName = `${tenantId}/${checksum}-${safeFilename(filename)}`;
    const bucket = await this.getBucket();
    const file = bucket.file(objectName);

    const [exists] = await file.exists();
    if (!exists) {
      // Bucket versioning (infra/terraform/modules/storage) means even a same-name
      // overwrite would create a new object generation rather than losing the old bytes —
      // this existence check just avoids a redundant upload for identical content.
      await file.save(data, { resumable: false });
    }

    return { ref: `gs://${this.bucketName}/${objectName}`, checksum, bytes: data.byteLength };
  }

  async getObject(ref: string): Promise<Buffer> {
    if (!ref.startsWith(`gs://${this.bucketName}/`)) {
      throw new Error(`Ref does not belong to this bucket: ${ref}`);
    }
    const objectName = ref.slice(`gs://${this.bucketName}/`.length);
    const bucket = await this.getBucket();
    const [buf] = await bucket.file(objectName).download();
    return buf;
  }
}

let instance: ObjectStorage | null = null;

export function getObjectStorage(): ObjectStorage {
  if (instance) return instance;

  const projectId = process.env.GCP_PROJECT_ID;
  if (projectId) {
    const bucketName = process.env.RAW_DATA_BUCKET;
    if (!bucketName) {
      throw new Error("RAW_DATA_BUCKET must be set when GCP_PROJECT_ID is set");
    }
    instance = new GcsObjectStorage(projectId, bucketName);
  } else {
    const baseDir = process.env.LOCAL_STORAGE_DIR ?? join(process.cwd(), ".data", "raw");
    instance = new LocalObjectStorage(baseDir);
  }
  return instance;
}
