import "dotenv/config";
import { createApp } from "./app";
import { logger } from "./lib/logger";

// Defense in depth: every route is wrapped in asyncHandler (src/lib/asyncHandler.ts) so
// route-level errors should never reach here. This is a last-resort net for anything that
// slips through (e.g. an error inside a middleware, not a route) — log it before Cloud Run
// restarts the container, instead of losing the reason in a bare stack trace.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaught exception");
  process.exit(1);
});

const port = Number(process.env.PORT ?? 8080);

const app = createApp();
app.listen(port, () => {
  logger.info({ port }, "transformiq-backend listening");
});
