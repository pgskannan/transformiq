import cors from "cors";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { authRouter } from "./routes/auth";
import { businessPartnersRouter } from "./routes/businessPartners";
import { datasetsRouter } from "./routes/datasets";
import { entityMatchesRouter } from "./routes/entityMatches";
import { healthRouter } from "./routes/health";
import { ingestionRouter } from "./routes/ingestion";
import { profilingRouter } from "./routes/profiling";
import { projectsRouter } from "./routes/projects";
import { suppliersRouter } from "./routes/suppliers";
import { tenantsRouter } from "./routes/tenants";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(
    pinoHttp({
      logger,
      // pino-http's default request serializer logs raw request headers, which by default
      // means the JWT (Authorization) and the platform-admin shared secret
      // (x-platform-admin-key) would land in every access log line — verified directly
      // against pino-std-serializers while writing docs/security/encryption-checklist.md,
      // not assumed. AGENTS.md Do-Not-Do rule #9: never put a secret in code, committed
      // config, or logs.
      redact: {
        paths: ["req.headers.authorization", 'req.headers["x-platform-admin-key"]'],
        censor: "[redacted]",
      },
    })
  );

  app.use(healthRouter);
  app.use(authRouter);
  app.use(tenantsRouter);
  app.use(projectsRouter);
  app.use(datasetsRouter);
  app.use(ingestionRouter);
  app.use(profilingRouter);
  app.use(businessPartnersRouter);
  app.use(suppliersRouter);
  app.use(entityMatchesRouter);

  // Not-found + error handling. Deliberately never leaks stack traces to the client.
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // multer reports its own errors (e.g. LIMIT_FILE_SIZE) via next(err) rather than
    // throwing inside an async handler, so they land here rather than in asyncHandler.
    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: `Upload rejected: ${err.message}` });
      return;
    }
    req.log?.error({ err }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
