// Structured logging (TQ-007). pino emits JSON, which Cloud Logging parses natively when
// running on Cloud Run — no separate log-shipping agent needed.
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "transformiq-backend" },
});
