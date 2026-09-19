import { describe, expect, it } from "bun:test";

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:4000";
const WEB_URL = process.env.WEB_URL || "http://localhost:4321";
const sampleId = crypto.randomUUID();

describe("Platform Administration API & Console (/admin)", () => {
  it("rejects anonymous access to every privileged administration route", async () => {
    const requests: Array<Promise<Response>> = [
      fetch(`${GATEWAY_URL}/api/v1/admin/overview`),
      fetch(`${GATEWAY_URL}/api/v1/admin/organizations`),
      fetch(`${GATEWAY_URL}/api/v1/admin/stores`),
      fetch(`${GATEWAY_URL}/api/v1/admin/organizations/${sampleId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxUsers: 25 })
      }),
      fetch(`${GATEWAY_URL}/api/v1/admin/users`),
      fetch(`${GATEWAY_URL}/api/v1/admin/users/${sampleId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ACTIVE" })
      }),
      fetch(`${GATEWAY_URL}/api/v1/admin/query/models`),
      fetch(`${GATEWAY_URL}/api/v1/admin/query/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchText: "status:ACTIVE" })
      }),
      fetch(`${GATEWAY_URL}/api/v1/admin/query/execute`, {
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
      fetch(`${GATEWAY_URL}/api/v1/admin/system`),
      fetch(`${GATEWAY_URL}/api/v1/hub/sql/tables`)
    ];

    const responses = await Promise.all(requests);
    expect(responses.slice(0, -1).every((response) => response.status === 401)).toBe(true);
    expect(responses.at(-1)?.status).toBe(404);
    const removedModeRoute = await fetch(`${GATEWAY_URL}/api/v1/admin/system/mode`, { method: "POST" });
    expect(removedModeRoute.status).toBe(404);
  });

  it("serves /admin without exposing a client-side bearer-token flow", async () => {
    const adminRes = await fetch(`${WEB_URL}/admin`);
    expect(adminRes.status).toBe(200);
    const adminHtml = await adminRes.text();
    expect(adminHtml).toContain("Platform Administration Console");
    expect(adminHtml).toContain("Organizations & Quotas");
    expect(adminHtml).toContain("Stores & IDs");
    expect(adminHtml).toContain("admin-orgs-search");
    expect(adminHtml).toContain("admin-stores-search");
    expect(adminHtml).toContain("admin-subs-search");
    expect(adminHtml).toContain("admin-users-search");
    expect(adminHtml).toContain("/api/v1/admin/query");
    expect(adminHtml).not.toContain("Authorization: Bearer");
    expect(adminHtml).not.toContain("SUPABASE_SECRET_KEY");
    expect(adminHtml).toContain("/auth.js");

    const removedDemoBypass = await fetch(`${GATEWAY_URL}/api/v1/admin/demo-bypass`, { method: "POST" });
    expect(removedDemoBypass.status).toBe(404);

    const landingRes = await fetch(`${WEB_URL}/`);
    expect(landingRes.status).toBe(200);
    const landingHtml = await landingRes.text();
    expect(landingHtml).not.toContain("Open Testing Mode");
    expect(landingHtml).toContain("Enterprise Multi-Tenant Operating Platform");
    expect(landingHtml).toContain("/api/v1/hub/bootstrap");
    expect(landingHtml).toContain("/auth.js");
    expect(landingHtml).toContain("landing-account");
    expect(landingHtml).toContain("Open Workspace");
    expect(landingHtml).toContain("Continue to Workspace");
    expect(landingHtml).toContain("Manage Organization");

    const removedSqlPage = await fetch(`${WEB_URL}/sql`);
    expect(removedSqlPage.status).toBe(404);
  });
});
