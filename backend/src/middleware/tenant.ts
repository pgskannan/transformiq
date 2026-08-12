// Attaches req.tenantId from the authenticated user's token claim. Must run after
// requireAuth(). This is a convenience accessor only — the actual enforcement is
// withTenant()'s SET LOCAL + Postgres RLS (see src/lib/db.ts and ADR 0002). Do not treat
// req.tenantId as sufficient authorization by itself.

import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

export function attachTenant() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "attachTenant() requires requireAuth() to run first" });
      return;
    }
    req.tenantId = req.user.tenantId;
    next();
  };
}
