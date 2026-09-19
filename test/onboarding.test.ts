import { describe, expect, it } from "bun:test";
import { createAevoClient } from "../packages/sdk/src";

const GATEWAY_URL = process.env.API_URL || "http://localhost:4000";

describe("Aevo Hub: Onboarding & server-resolved entitlements", () => {
  const client = createAevoClient({
    baseUrl: GATEWAY_URL
  });

  let testSessionId: string;
  let testOrgId: string;
  let testStoreId: string;
  const testEmail = `test.owner.${Date.now()}@aevo.test`;

  it("1. Verifies production entitlement mode is the safe default", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/hub/operating-mode`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mode).toBe("production");
    expect(data.isUnlimitedTesting).toBe(false);
  });

  it("2. Requires an authenticated session for organization entitlements", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/v1/hub/entitlements/pos/check`, {
    });
    expect(res.status).toBe(401);
  });

  it("3. User Register: creates user and starts onboarding session", async () => {
    const res = await client.hub.onboarding.register({
      email: testEmail,
      password: "Password1234!",
      fullName: "Nattawut Somchai"
    });

    expect(res.success).toBe(true);
    expect(res.user.email).toBe(testEmail);
    expect(res.session).toBeDefined();
    expect(res.session.currentStep).toBe("REGISTER");
    expect(res.session.completedSteps).toContain("REGISTER");

    testSessionId = res.session.id;
  });

  it("4. Objectives Selection: saves chosen business goals and advances step", async () => {
    expect(testSessionId).toBeDefined();

    const res = await client.hub.onboarding.setObjectives({
      sessionId: testSessionId,
      objectives: ["pos", "booking", "inventory"]
    });

    expect(res.success).toBe(true);
    expect(res.session.currentStep).toBe("ORGANIZATION");
    expect(res.session.objectives).toContain("pos");
    expect(res.session.objectives).toContain("booking");
    expect(res.session.completedSteps).toContain("OBJECTIVES");
  });

  it("5. Organization Setup: creates business profile with Owner RBAC", async () => {
    const res = await client.hub.onboarding.setupOrganization({
      sessionId: testSessionId,
      name: "Aevo Arena & Bistro",
      legalName: "Aevo Arena Co., Ltd.",
      businessType: "sport_venue",
      country: "TH",
      currency: "THB",
      timezone: "Asia/Bangkok",
      contactEmail: testEmail,
      contactPhone: "081-999-8888"
    });

    expect(res.success).toBe(true);
    expect(res.organizationId).toBeDefined();
    expect(res.session.organizationId).toBe(res.organizationId);
    expect(res.session.currentStep).toBe("STORE");
    expect(res.session.completedSteps).toContain("ORGANIZATION");

    testOrgId = res.organizationId;
  });

  it("6. Store Setup: configures branch and operational mode", async () => {
    const res = await client.hub.onboarding.setupStore({
      sessionId: testSessionId,
      organizationId: testOrgId,
      name: "Ratchada Branch",
      code: "BKK-01",
      storeMode: "POS_BOOKING",
      address: "123 Ratchadapisek Rd, Bangkok",
      phone: "02-123-4567"
    });

    expect(res.success).toBe(true);
    expect(res.storeId).toBeDefined();
    expect(res.session.storeId).toBe(res.storeId);
    expect(res.session.currentStep).toBe("APPS");
    expect(res.session.completedSteps).toContain("STORE");

    testStoreId = res.storeId;
  });

  it("7. App Selection: activates apps through the entitlement workflow", async () => {
    const res = await client.hub.onboarding.setupApps({
      sessionId: testSessionId,
      organizationId: testOrgId,
      appIds: ["pos", "kiosk", "booking"]
    });

    expect(res.success).toBe(true);
    expect(res.session.currentStep).toBe("RESOURCES");
    expect(res.session.completedSteps).toContain("APPS");
  });

  it("8. Booking Resources Setup: configures courts and tables", async () => {
    const res = await client.hub.onboarding.setupBooking({
      sessionId: testSessionId,
      organizationId: testOrgId,
      storeId: testStoreId,
      venueName: "Aevo Badminton Complex",
      businessType: "court",
      resourceNames: ["Court A1", "Court A2", "Court A3"],
      durationMinutes: 60,
      priceMinor: 25000,
      enableWaitlist: true
    });

    expect(res.success).toBe(true);
    expect(res.venueId).toBeDefined();
    expect(res.session.currentStep).toBe("STAFF");
    expect(res.session.completedSteps).toContain("RESOURCES");
  });

  it("9. Setup Progress Checklist: reports progress percent and step completion", async () => {
    const res = await client.hub.onboarding.getChecklist(testOrgId, testStoreId);
    expect(res.success).toBe(true);
    expect(res.checklist.items.length).toBeGreaterThanOrEqual(6);
    expect(res.checklist.totalProgressPercent).toBeGreaterThanOrEqual(50);
    expect(res.checklist.isReady).toBe(true);

    const orgItem = res.checklist.items.find((i) => i.id === "org_setup");
    expect(orgItem?.status).toBe("COMPLETED");

    const storeItem = res.checklist.items.find((i) => i.id === "store_setup");
    expect(storeItem?.status).toBe("COMPLETED");
  });

  it("10. Completes Onboarding: sets session is_completed and transitions organization", async () => {
    const res = await client.hub.onboarding.complete(testSessionId);
    expect(res.success).toBe(true);
    expect(res.session.isCompleted).toBe(true);
    expect(res.session.currentStep).toBe("COMPLETE");
    expect(res.session.completedSteps).toContain("COMPLETE");
  });
});
