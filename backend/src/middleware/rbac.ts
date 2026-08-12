// RBAC (TQ-011). SRS §19: "Separate access for viewing, modifying, approving, exporting,
// and administering." This maps the five UserRole values (see db/migrations/0001_init.sql)
// onto that five-permission model — a role is not itself a permission, and route handlers
// must declare the permission they need, not the role.

import type { NextFunction, Request, Response } from "express";

export type Permission = "view" | "modify" | "approve" | "export" | "admin";
export type Role = "VIEWER" | "STEWARD" | "APPROVER" | "EXPORTER" | "ADMIN";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  VIEWER: ["view"],
  STEWARD: ["view", "modify"],
  APPROVER: ["view", "modify", "approve"],
  EXPORTER: ["view", "export"],
  ADMIN: ["view", "modify", "approve", "export", "admin"],
};

export function roleHasPermission(role: string, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role as Role] ?? []).includes(permission);
}

/** Requires requireAuth() to have already run and populated req.user. */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "requirePermission() requires requireAuth() to run first" });
      return;
    }
    if (!roleHasPermission(req.user.role, permission)) {
      req.log?.warn(
        { role: req.user.role, permission, userId: req.user.userId },
        "RBAC: permission denied"
      );
      res.status(403).json({
        error: `Role "${req.user.role}" does not have "${permission}" permission`,
      });
      return;
    }
    next();
  };
}

/**
 * Platform-level administration (creating a tenant) is not a tenant-scoped operation — no
 * tenant-scoped role, including ADMIN, should be able to authorize it, because ADMIN is
 * scoped to a tenant that doesn't exist yet at the moment of creation. This checks a
 * separate shared secret instead of a per-tenant JWT. Closes the "tenant creation is wide
 * open" gap called out in Sprint 1's README.
 */
export function requirePlatformAdmin() {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.PLATFORM_ADMIN_API_KEY;
    if (!expected) {
      req.log?.error("PLATFORM_ADMIN_API_KEY is not configured — refusing all platform-admin requests");
      res.status(503).json({ error: "Platform administration is not configured" });
      return;
    }
    const provided = req.headers["x-platform-admin-key"];
    if (provided !== expected) {
      res.status(403).json({ error: "Missing or invalid platform admin key" });
      return;
    }
    next();
  };
}
