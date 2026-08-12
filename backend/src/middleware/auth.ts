// JWT verification middleware (TQ-006). Designed to work against any OIDC-compliant issuer
// (Identity Platform, Auth0, etc.) via JWKS — no real IdP is wired up in Sprint 1, so a local
// HS256 dev-token path is also supported purely for local development and tests. Never use
// the dev-token path outside NODE_ENV=development/test.

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const DEV_JWT_SECRET = process.env.DEV_JWT_SECRET ?? "local-dev-only-not-for-production";

let jwks: jwksClient.JwksClient | null = null;
function getJwks(): jwksClient.JwksClient {
  if (!jwks) {
    const jwksUri = process.env.OIDC_JWKS_URI;
    if (!jwksUri) {
      throw new Error("OIDC_JWKS_URI is not set — cannot verify tokens against a real issuer.");
    }
    jwks = jwksClient({ jwksUri });
  }
  return jwks;
}

function verifyDevToken(token: string): AuthenticatedUser {
  const payload = jwt.verify(token, DEV_JWT_SECRET) as jwt.JwtPayload;
  return extractClaims(payload);
}

async function verifyOidcToken(token: string): Promise<AuthenticatedUser> {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header.kid;
  if (!kid) throw new Error("Token is missing a key ID (kid)");

  const key = await getJwks().getSigningKey(kid);
  const payload = jwt.verify(token, key.getPublicKey(), {
    algorithms: ["RS256"],
    issuer: process.env.JWT_ISSUER,
  }) as jwt.JwtPayload;

  return extractClaims(payload);
}

function extractClaims(payload: jwt.JwtPayload): AuthenticatedUser {
  const { sub, tenant_id: tenantId, email, role } = payload;
  if (!sub || !tenantId || !email || !role) {
    throw new Error(
      "Token is missing required claims (sub, tenant_id, email, role). RBAC (TQ-011) and " +
        "tenant isolation (TQ-012) both depend on tenant_id being present on every token."
    );
  }
  return { userId: sub, tenantId, email, role };
}

export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or malformed Authorization header" });
      return;
    }
    const token = header.slice("Bearer ".length);

    try {
      const useDevToken =
        process.env.NODE_ENV !== "production" && !process.env.OIDC_JWKS_URI;
      req.user = useDevToken ? verifyDevToken(token) : await verifyOidcToken(token);
      next();
    } catch (err) {
      req.log?.warn({ err }, "auth failed");
      res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

/** Issues a dev-only token for local testing. Never exposed as a real API route. */
export function issueDevToken(claims: Omit<AuthenticatedUser, "userId"> & { userId?: string }) {
  return jwt.sign(
    {
      sub: claims.userId ?? "dev-user",
      tenant_id: claims.tenantId,
      email: claims.email,
      role: claims.role,
    },
    DEV_JWT_SECRET,
    { expiresIn: "1h" }
  );
}
