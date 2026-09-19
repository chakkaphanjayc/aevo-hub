import { describe, expect, it } from "bun:test";
import { createAevoClient } from "../packages/sdk/src";

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:4000";

describe("Aevo Hub: canonical session flow", () => {
  const timestamp = Date.now();
  const testEmail = `owner_${timestamp}@aevo.test`;
  const testPassword = "Password123!";
  const client = createAevoClient({ baseUrl: GATEWAY_URL });
  let sessionId: string;
  let organizationId: string;
  let storeId: string;

  it("1. Register: creates an identity and captures the application session", async () => {
    const result = await client.hub.onboarding.register({
      email: testEmail,
      password: testPassword,
      fullName: `Founder Test ${timestamp}`
    });

    expect(result.success).toBe(true);
    expect(result.user.email).toBe(testEmail);
    expect(result.session.currentStep).toBe("REGISTER");
    sessionId = result.session.id;
  });

  it("2. Login: rotates the browser session without returning a bearer token", async () => {
    const result = await client.auth.login({ email: testEmail, password: testPassword });
    expect(result.success).toBe(true);
    expect(result.session.expiresAt).toBeDefined();
    expect(result).not.toHaveProperty("accessToken");
  });

  it("3. Locale: stores the per-user interface preference", async () => {
    const initial = await client.auth.getPreferences();
    expect(initial.preferences.userId).toBeDefined();
    expect(initial.preferences.locale).toBeNull();

    const updated = await client.auth.updatePreferences("th");
    expect(updated.preferences.locale).toBe("th");

    const persisted = await client.auth.getPreferences();
    expect(persisted.preferences.locale).toBe("th");
  });

  it("4. Unsupported demo login is removed", async () => {
    const response = await fetch(`${GATEWAY_URL}/api/auth/demo-login`, {
      method: "POST"
    });
    expect(response.status).toBe(404);
  });

  it("4. Objectives: writes progress through the authenticated session", async () => {
    const result = await client.hub.onboarding.setObjectives({
      sessionId,
      objectives: ["pos", "booking", "all"]
    });
    expect(result.success).toBe(true);
    expect(result.session.objectives).toContain("pos");
    expect(result.session.completedSteps).toContain("OBJECTIVES");
  });

  it("5. Organization: creates a tenant with owner membership", async () => {
    const result = await client.hub.onboarding.setupOrganization({
      sessionId,
      name: `Arena & Cafe ${timestamp}`,
      legalName: `Aevo Sports Ltd ${timestamp}`,
      businessType: "sport_venue",
      country: "TH",
      timezone: "Asia/Bangkok",
      currency: "THB"
    });
    expect(result.success).toBe(true);
    expect(result.organizationId).toBeDefined();
    expect(result.session.organizationId).toBe(result.organizationId);
    organizationId = result.organizationId;
  });

  it("6. Store: provisions the first operating location", async () => {
    const result = await client.hub.onboarding.setupStore({
      sessionId,
      organizationId,
      name: "Ratchada Flagship Arena",
      code: `RCD-${String(timestamp).slice(-4)}`,
      storeMode: "POS_BOOKING",
      address: "123 Ratchadaphisek Road, Bangkok"
    });
    expect(result.success).toBe(true);
    expect(result.storeId).toBeDefined();
    expect(result.session.storeId).toBe(result.storeId);
    storeId = result.storeId;
  });

  it("7. Apps: follows the same session and tenant boundary", async () => {
    const apps = await client.hub.onboarding.setupApps({
      sessionId,
      organizationId,
      appIds: ["pos", "kiosk", "booking", "crm", "inventory"]
    });
    expect(apps.success).toBe(true);

  }, 20000);

  it("8. Checklist: reports tenant readiness from Supabase", async () => {
    const result = await client.hub.onboarding.getChecklist(organizationId, storeId);
    expect(result.success).toBe(true);
    expect(result.checklist.totalProgressPercent).toBeGreaterThan(0);
    expect(result.checklist.isReady).toBe(true);
    expect(result.checklist.items
      .filter((item) => item.category === "REQUIRED")
      .every((item) => item.status === "COMPLETED"))
      .toBe(true);
    expect(result.checklist.items.length).toBe(8);
  });

  it("9. Complete: closes the same server-owned onboarding session", async () => {
    const result = await client.hub.onboarding.complete(sessionId);
    expect(result.success).toBe(true);
    expect(result.session.isCompleted).toBe(true);
    expect(result.session.currentStep).toBe("COMPLETE");
  });
});
