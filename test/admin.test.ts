import { describe, expect, it } from "bun:test";

const EDGE_URL = process.env.EDGE_URL || "http://localhost:4001";
const sampleId = crypto.randomUUID();

describe("Platform Administration API", () => {
  it("rejects anonymous access to every privileged administration route", async () => {
    const requests: Array<Promise<Response>> = [
      fetch(`${EDGE_URL}/api/v1/admin/overview`),
      fetch(`${EDGE_URL}/api/v1/admin/organizations`),
      fetch(`${EDGE_URL}/api/v1/admin/stores`),
      fetch(`${EDGE_URL}/api/v1/admin/applications`),
      fetch(`${EDGE_URL}/api/v1/admin/audit-logs`),
      fetch(`${EDGE_URL}/api/v1/admin/go/overview`),
      fetch(`${EDGE_URL}/api/v1/admin/go/settings`),
      fetch(`${EDGE_URL}/api/v1/admin/tracedee/reputation/evidence`),
      fetch(`${EDGE_URL}/api/v1/admin/tracedee/ranking/guardrails`),
      fetch(`${EDGE_URL}/api/v1/admin/go/feature-flags/taste_ranking_v1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, rolloutPercent: 0, config: { mode: "SHADOW" }, reason: "anonymous test" })
      }),
      fetch(`${EDGE_URL}/api/v1/admin/organizations/${sampleId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxUsers: 25 })
      }),
      fetch(`${EDGE_URL}/api/v1/admin/users`),
      fetch(`${EDGE_URL}/api/v1/admin/users/${sampleId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE" })
      }),
      fetch(`${EDGE_URL}/api/v1/admin/query/models`),
      fetch(`${EDGE_URL}/api/v1/admin/query/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchText: "status:ACTIVE" })
      }),
      fetch(`${EDGE_URL}/api/v1/admin/query/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            version: 1,
            model: "admin.organization",
            fields: ["id", "name"],
            pagination: { limit: 10, offset: 0 }
          }
        })
      }),
      fetch(`${EDGE_URL}/api/v1/admin/system`),
      fetch(`${EDGE_URL}/api/v1/hub/sql/tables`)
    ];

    const responses = await Promise.all(requests);
    expect(responses.slice(0, -1).every((response) => response.status === 401)).toBe(true);
    expect(responses.at(-1)?.status).toBe(404);
    const removedModeRoute = await fetch(`${EDGE_URL}/api/v1/admin/system/mode`, { method: "POST" });
    expect(removedModeRoute.status).toBe(404);
    const removedDemoBypass = await fetch(`${EDGE_URL}/api/v1/admin/demo-bypass`, { method: "POST" });
    expect(removedDemoBypass.status).toBe(404);
  });
});
