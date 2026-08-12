// Express 4 does not catch rejected promises from async route handlers — an unhandled
// rejection in a route crashes the whole process instead of producing a 500 (verified live
// while building this scaffold: a DB connection blip took the entire server down). Wrap
// every async handler with this so errors reach the error-handling middleware in app.ts.
import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
