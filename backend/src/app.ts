import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { authRouter } from "./routes/auth";
import { datasetsRouter } from "./routes/datasets";
import { healthRouter } from "./routes/health";
import { projectsRouter } from "./routes/projects";
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

  // Not-found + error handling. Deliberately never leaks stack traces to the client.
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    req.log?.error({ err }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
