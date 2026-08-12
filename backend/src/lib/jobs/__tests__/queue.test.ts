// TQ-023's actual mechanism: enqueue() must return before the job's work runs. This is the
// unit-level proof; src/__tests__/ingestion.test.ts proves the same thing at the HTTP layer
// (POST returns 202 before detection/persistence has happened).
import { getJobQueue, registerJobHandler, resetJobQueueForTests } from "../queue";

describe("LocalAsyncJobQueue (dev/test backend — GCP_PROJECT_ID unset)", () => {
  const originalProjectId = process.env.GCP_PROJECT_ID;

  beforeEach(() => {
    resetJobQueueForTests();
    delete process.env.GCP_PROJECT_ID;
  });

  afterAll(() => {
    if (originalProjectId !== undefined) process.env.GCP_PROJECT_ID = originalProjectId;
  });

  it("enqueue() resolves before the registered handler has even started running", async () => {
    let handlerStarted = false;
    let handlerFinished = false;
    registerJobHandler("test.slow-job", async () => {
      handlerStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      handlerFinished = true;
    });

    await getJobQueue().enqueue("test.slow-job", { some: "payload" });

    // If this were `await handler(payload)` directly instead of setImmediate-deferred, both
    // of these would already be true here — that's exactly the blocking behavior TQ-023
    // exists to avoid.
    expect(handlerStarted).toBe(false);
    expect(handlerFinished).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(handlerStarted).toBe(true);
    expect(handlerFinished).toBe(true);
  });

  it("rejects for a job type with no registered handler", async () => {
    await expect(getJobQueue().enqueue("no.such.job.type", {})).rejects.toThrow(
      /No job handler registered/
    );
  });

  it("a handler that throws does not reject enqueue() or crash the process — it's caught internally", async () => {
    registerJobHandler("test.failing-job", async () => {
      throw new Error("boom");
    });

    await expect(getJobQueue().enqueue("test.failing-job", {})).resolves.toBeUndefined();
  });
});
