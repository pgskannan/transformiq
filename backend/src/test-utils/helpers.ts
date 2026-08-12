import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";
import { issueDevToken } from "../middleware/auth";

const PLATFORM_ADMIN_KEY = process.env.PLATFORM_ADMIN_API_KEY ?? "test-platform-admin-key";

export async function makeTenant(app: Express, name: string): Promise<string> {
  const res = await request(app)
    .post("/v1/tenants")
    .set("x-platform-admin-key", PLATFORM_ADMIN_KEY)
    .send({ name });
  if (res.status !== 201) {
    throw new Error(`makeTenant() failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

export function tokenFor(tenantId: string, role: string = "STEWARD"): string {
  return issueDevToken({ tenantId, email: `user-${randomUUID()}@example.com`, role });
}
