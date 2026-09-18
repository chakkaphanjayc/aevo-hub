import { beforeAll, describe, expect, it } from "bun:test";
import { createAevoClient, GatewayError } from "../packages/sdk/src";

const GATEWAY_URL = process.env.GATEWAY_URL || process.env.API_URL || "http://localhost:4000";
const WEB_URL = process.env.WEB_URL || "http://localhost:4321";

async function gatewayStatus(operation: () => Promise<unknown>): Promise<number> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof GatewayError) return error.status;
    throw error;
  }
  throw new Error("Expected the gateway request to fail");
}

describe("Aevo security architecture invariants", () => {
  const timestamp = Date.now();
  const client = createAevoClient({ baseUrl: GATEWAY_URL });
  let organizationId: string;

  beforeAll(async () => {
    const email = `security.owner.${timestamp}@aevo.test`;
    const registration = await client.hub.onboarding.register({
      email,
      password: "Password123!",
      fullName: "Security Flow Owner"
    });
    await client.auth.login({ email, password: "Password123!" });

    await client.hub.onboarding.setObjectives({
      sessionId: registration.session.id,
      objectives: ["pos"]
    });
    const organization = await client.hub.onboarding.setupOrganization({
      sessionId: registration.session.id,
      name: `Security Test Organization ${timestamp}`,
      businessType: "retail",
      country: "TH",
      timezone: "Asia/Bangkok",
      currency: "THB"
    });
    organizationId = organization.organizationId;
    client.setOrganizationId(organizationId);
  }, 30_000);

  it("rejects anonymous and fabricated bearer authentication", async () => {
    const anonymous = await fetch(`${GATEWAY_URL}/api/v1/admin/overview`);
    expect(anonymous.status).toBe(401);

    const fabricated = await fetch(`${GATEWAY_URL}/api/v1/hub/me`, {
      headers: { Authorization: "Bearer invalid-access-token" }
    });
    expect(fabricated.status).toBe(401);

    const removedDemoLogin = await fetch(`${GATEWAY_URL}/api/auth/demo-login`, { method: "POST" });
    expect(removedDemoLogin.status).toBe(404);
  });

  it("keeps platform administration separate from organization ownership", async () => {
    const removedSqlSurface = await fetch(`${GATEWAY_URL}/api/v1/hub/sql`, { method: "POST" });
    expect(removedSqlSurface.status).toBe(404);
    expect(await gatewayStatus(() => client.request("/api/v1/admin/overview"))).toBe(403);
  });

  it("enforces the tenant boundary for a valid session", async () => {
    const foreignOrganizationId = "a0000000-0000-4000-a000-000000000099";
    expect(await gatewayStatus(() => client.hub.listStores(foreignOrganizationId))).toBe(403);
    client.setOrganizationId(organizationId);
  });

  it("does not expose server credentials to public web surfaces", async () => {
    for (const path of ["/admin", "/organize", "/workspace", "/auth.js", "/shared.css"]) {
      const response = await fetch(`${WEB_URL}${path}`);
      if (response.status !== 200) continue;
      const body = await response.text();
      expect(body).not.toContain("SUPABASE_SECRET_KEY");
      expect(body).not.toContain("postgres://");
      expect(body).not.toContain("sb_secret_");
    }
  });
});
