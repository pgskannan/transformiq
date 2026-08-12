// TQ-003 acceptance criteria: /v1/health returns 200; service is independently deployable.
import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/v1/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "transformiq-backend",
    version: "0.1.0",
  });
});
