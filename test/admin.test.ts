import { describe, expect, it } from "bun:test";

const EDGE_URL = process.env.EDGE_URL || "http://localhost:4001";

describe("Platform Administration API", () => {
  it("rejects anonymous access to every privileged administration route", async () => {
    const requests: Array<Promise<Response>> = [
      fetch(`${EDGE_URL}/api/v1/admin/overview`),
      fetch(`${EDGE_URL}/api/v1/admin/applications`),
      fetch(`${EDGE_URL}/api/v1/admin/connections`),
      fetch(`${EDGE_URL}/api/v1/admin/audit-logs`),
      fetch(`${EDGE_URL}/api/v1/admin/organizations`),
      fetch(`${EDGE_URL}/api/v1/admin/subscriptions`),
      fetch(`${EDGE_URL}/api/v1/admin/users`),
      fetch(`${EDGE_URL}/api/v1/admin/go/overview`),
      fetch(`${EDGE_URL}/api/v1/admin/go/settings`),
      fetch(`${EDGE_URL}/api/v1/admin/go/feature-flags/taste_ranking_v1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, rolloutPercent: 0, config: { mode: "SHADOW" }, reason: "anonymous test" })
      })
    ];

    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 401)).toBe(true);

    const removedLegacyHubRoute = await fetch(`${EDGE_URL}/api/v1/hub/sql/tables`);
    expect(removedLegacyHubRoute.status).toBe(404);

    const removedRoutes = await Promise.all([
      fetch(`${EDGE_URL}/api/v1/admin/stores`),
      fetch(`${EDGE_URL}/api/v1/admin/query/models`),
      fetch(`${EDGE_URL}/api/v1/admin/system`)
    ]);
    expect(removedRoutes.every((response) => response.status === 404)).toBe(true);

    const removedModeRoute = await fetch(`${EDGE_URL}/api/v1/admin/system/mode`, { method: "POST" });
    expect(removedModeRoute.status).toBe(404);
    const removedDemoBypass = await fetch(`${EDGE_URL}/api/v1/admin/demo-bypass`, { method: "POST" });
    expect(removedDemoBypass.status).toBe(404);
  });
});
