import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";
import { projectsRouter } from "./routes/projects";
import { tenantsRouter } from "./routes/tenants";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use(tenantsRouter);
  app.use(projectsRouter);

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
