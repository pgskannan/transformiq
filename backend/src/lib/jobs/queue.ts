// Async job queue abstraction (TQ-023). Two backends, same interface as
// lib/objectStorage.ts's pattern:
//  - local (dev/test, used whenever GCP_PROJECT_ID is unset): runs the job on the Node event
//    loop via setImmediate, so the HTTP request that enqueued it gets its response before the
//    job's work starts — this is what "does not block the API" actually means and is
//    verified directly in src/__tests__/ingestion.test.ts (POST returns fast; GET polls
//    until the deferred work completes).
//  - Pub/Sub (real deployments): publishes a message; a separate consumer (Cloud Run Jobs
//    triggered via Eventarc, or a push subscription) is what actually runs the job. **Only
//    the publish side is implemented here** — this scaffold has no separate worker
//    process/service to be that consumer, and building one that's never been exercised
//    against a real Pub/Sub topic would be pretending to more completeness than exists.
//    Flagged as a real, tracked gap (see README), not silently assumed solved.
//
// Job payloads are deliberately plain, serializable data — no closures, no live DB/objects —
// because that's what a real Pub/Sub message requires. The local backend could technically
// get away with capturing a closure (same process, same memory), but doing so would hide a
// design mistake that only shows up once you actually try to run this against Pub/Sub. Keep
// payloads serializable even though nothing enforces it locally.

export interface JobQueue {
  enqueue(jobType: string, payload: unknown): Promise<void>;
}

export type JobHandler = (payload: unknown) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/** Every job type must register a handler before anything enqueues it — used by both the
 *  local queue (which dispatches immediately, deferred) and, if it ever runs, whatever calls
 *  the Pub/Sub consumer's message handler with the same jobType/payload shape. */
export function registerJobHandler(jobType: string, handler: JobHandler): void {
  handlers.set(jobType, handler);
}

class LocalAsyncJobQueue implements JobQueue {
  async enqueue(jobType: string, payload: unknown): Promise<void> {
    const handler = handlers.get(jobType);
    if (!handler) {
      throw new Error(`No job handler registered for job type "${jobType}"`);
    }
    // setImmediate, not a direct await: this is what actually defers the work past the
    // current request's response. If this were `await handler(payload)` the caller would
    // block until the job finished — exactly the behavior TQ-023 exists to avoid.
    setImmediate(() => {
      handler(payload).catch((err) => {
        // A job handler that throws here has already had its chance to record a "failed"
        // ingestion_runs row itself (see lib/jobs/ingestionJob.ts) — this catch is a last
        // resort so an unexpected throw doesn't become an unhandled rejection that crashes
        // the process, consistent with the asyncHandler/unhandledRejection posture
        // established in Sprint 1 for the same reason.
        // eslint-disable-next-line no-console
        console.error(`Job "${jobType}" failed outside its own error handling:`, err);
      });
    });
  }
}

class PubSubJobQueue implements JobQueue {
  constructor(
    private readonly projectId: string,
    private readonly topicName: string
  ) {}

  async enqueue(jobType: string, payload: unknown): Promise<void> {
    // Lazy import, same pattern as objectStorage.ts's GcsObjectStorage / secrets.ts — this
    // path has never run against a real Pub/Sub topic (no GCP project available while
    // building this).
    const { PubSub } = await import("@google-cloud/pubsub");
    const pubsub = new PubSub({ projectId: this.projectId });
    const data = Buffer.from(JSON.stringify({ jobType, payload }));
    await pubsub.topic(this.topicName).publishMessage({ data });
  }
}

let instance: JobQueue | null = null;

export function getJobQueue(): JobQueue {
  if (instance) return instance;

  const projectId = process.env.GCP_PROJECT_ID;
  if (projectId) {
    const topicName = process.env.INGESTION_JOBS_TOPIC;
    if (!topicName) {
      throw new Error("INGESTION_JOBS_TOPIC must be set when GCP_PROJECT_ID is set");
    }
    instance = new PubSubJobQueue(projectId, topicName);
  } else {
    instance = new LocalAsyncJobQueue();
  }
  return instance;
}

/** Test-only escape hatch: reset the memoized singleton so tests that toggle GCP_PROJECT_ID
 *  don't get a stale instance from an earlier test. */
export function resetJobQueueForTests(): void {
  instance = null;
}
