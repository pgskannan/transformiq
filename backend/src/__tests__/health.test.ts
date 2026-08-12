import request from "supertest";
import { createApp } from "../app";

describe("GET /v1/health", () => {
  it("returns 200 with service status", async () => {
    const app = createApp();
    const res = await request(app).get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("transformiq-backend");
  });
});

describe("unknown route", () => {
  it("returns 404", async () => {
    const app = createApp();
    const res = await request(app).get("/v1/does-not-exist");
    expect(res.status).toBe(404);
  });
});
