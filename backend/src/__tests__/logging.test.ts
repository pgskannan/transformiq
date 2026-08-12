// TQ-016/TQ-019: proves — rather than assumes — that secrets never reach the logs. pino-http's
// default request serializer logs raw headers, which by default would include the JWT
// (Authorization) and the platform-admin shared secret (x-platform-admin-key); this was
// discovered by direct inspection of pino-std-serializers output while writing
// docs/security/encryption-checklist.md, then fixed with a `redact` config in app.ts. This
// test is what stops that regressing silently.
import request from "supertest";
import { createApp } from "../app";

describe("request logging redacts credentials (TQ-016)", () => {
  it("never writes the raw Authorization or x-platform-admin-key header value to stdout", async () => {
    const secretToken = "super.secret.jwt.value";
    const secretAdminKey = "super-secret-admin-key-value";

    const chunks: string[] = [];
    const writeSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        chunks.push(typeof chunk === "string" ? chunk : chunk!.toString());
        return true;
      });

    try {
      const app = createApp();
      await request(app)
        .get("/v1/projects")
        .set("Authorization", `Bearer ${secretToken}`)
        .set("x-platform-admin-key", secretAdminKey);
    } finally {
      writeSpy.mockRestore();
    }

    const allOutput = chunks.join("\n");
    expect(allOutput).not.toContain(secretToken);
    expect(allOutput).not.toContain(secretAdminKey);
    // Confirms the redaction actually ran (as opposed to the headers just not being logged
    // at all, which would hide a different bug) — the censor marker should be present.
    expect(allOutput).toContain("[redacted]");
  });
});
