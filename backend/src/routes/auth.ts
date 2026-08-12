// Dev-only token issuance so the walking skeleton (and Jest/supertest) can exercise
// requireAuth() without a real OIDC provider. This route must never exist in production —
// it is hard-guarded below, not just "trusted" to be unused.
import { Router } from "express";
import { z } from "zod";
import { issueDevToken } from "../middleware/auth";

export const authRouter = Router();

const devTokenSchema = z.object({
  tenantId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["VIEWER", "STEWARD", "APPROVER", "EXPORTER", "ADMIN"]),
});

authRouter.post("/v1/auth/dev-token", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  const parsed = devTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const token = issueDevToken(parsed.data);
  res.status(200).json({ token });
});
