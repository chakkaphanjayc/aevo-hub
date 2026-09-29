import { describe, expect, it } from "bun:test";

const edgeUrl = process.env.EDGE_URL?.trim()
  || process.env.API_URL?.trim()
  || "http://localhost:4000";

type CookieMap = Map<string, string>;

function cookieHeader(cookies: CookieMap): string {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function rememberCookies(response: Response, cookies: CookieMap): void {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const [pair] = header.split(";", 1);
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function request(cookies: CookieMap, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-aevo-app", "HUB");
  headers.set("x-aevo-contract-version", "v1");
  const currentCookies = cookieHeader(cookies);
  if (currentCookies) headers.set("cookie", currentCookies);
  const csrf = cookies.get("aevo_csrf");
  if (csrf && init.method && init.method !== "GET" && init.method !== "HEAD") headers.set("x-csrf-token", csrf);

  const response = await fetch(`${edgeUrl}${path}`, { ...init, headers });
  rememberCookies(response, cookies);
  return response;
}

describe("Core tenant and session security boundary", () => {
  it("issues a Hub session through Accounts and keeps authorization tenant-scoped", async () => {
    const cookies: CookieMap = new Map();
    const timestamp = Date.now();
    const registration = await request(cookies, "/api/v1/hub/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `core.security.${timestamp}@aevo.test`,
        password: "AevoDev!Security2026#",
        fullName: "Core Security Test"
      })
    });
    expect(registration.status).toBe(200);
    expect(cookies.get("aevo_hub_session")).toBeTruthy();
    expect(cookies.get("aevo_csrf")).toBeTruthy();

    const me = await request(cookies, "/api/auth/me");
    expect(me.status).toBe(200);
    const meBody = await me.json() as { user?: { email?: string }; principal?: unknown; access?: { allowed?: boolean; reason?: string } };
    expect(meBody.user?.email).toContain("@aevo.test");
    expect(meBody.principal).toBeNull();
    expect(meBody.access?.allowed).toBe(false);
    expect(meBody.access?.reason).toBe("MEMBERSHIP_REQUIRED");

    const applications = await request(cookies, "/api/v1/hub/apps");
    expect(applications.status).toBe(200);
    const applicationsBody = await applications.json() as { apps?: Array<{ code?: string; manifestVersion?: string; storeScoped?: boolean; capabilities?: string[] }> };
    const pos = applicationsBody.apps?.find((application) => application.code === "POS");
    expect(pos?.manifestVersion).toBe("v1");
    expect(pos?.storeScoped).toBe(true);
    expect(pos?.capabilities).toContain("catalog");

    const onboarding = await request(cookies, "/api/v1/hub/onboarding/session");
    expect(onboarding.status).toBe(200);
    const onboardingBody = await onboarding.json() as { session?: { userId?: string; isCompleted?: boolean } };
    expect(onboardingBody.session?.userId).toBeTruthy();
    expect(onboardingBody.session?.isCompleted).toBe(false);

    const favorite = await request(cookies, "/api/v1/hub/favorites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "MENU", targetKey: "organize.stores", position: 0 })
    });
    expect(favorite.status).toBe(200);
    const favoriteBody = await favorite.json() as { favorite?: { href?: string } };
    expect(favoriteBody.favorite?.href).toBe("/modern/stores");

    const foreignOrganization = await request(cookies, `/api/v1/hub/organizations/${crypto.randomUUID()}`);
    expect([403, 404]).toContain(foreignOrganization.status);
  }, 30_000);

  it("evaluates entitlement, expiry-independent feature state, and store binding server-side", async () => {
    const cookies: CookieMap = new Map();
    const timestamp = Date.now();
    const registration = await request(cookies, "/api/v1/hub/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `entitlement.security.${timestamp}@aevo.test`,
        password: "AevoDev!Entitlement2026#",
        fullName: "Entitlement Security Test"
      })
    });
    expect(registration.status).toBe(200);

    const onboarding = await request(cookies, "/api/v1/hub/onboarding/session");
    expect(onboarding.status).toBe(200);
    const onboardingBody = await onboarding.json() as { session?: { id?: string } };
    const sessionId = onboardingBody.session?.id;
    expect(sessionId).toBeTruthy();

    const organization = await request(cookies, "/api/v1/hub/onboarding/organization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        name: `Entitlement Security ${timestamp}`,
        slug: `entitlement-security-${timestamp}`
      })
    });
    expect(organization.status).toBe(200);
    const organizationBody = await organization.json() as { organizationId?: string };
    expect(organizationBody.organizationId).toBeTruthy();

    const hubAccess = await request(cookies, "/api/v1/access?application=HUB");
    expect(hubAccess.status).toBe(200);
    const hubAccessBody = await hubAccess.json() as { allowed?: boolean; reason?: string; permissions?: string[] };
    expect(hubAccessBody.allowed).toBe(true);
    expect(hubAccessBody.reason).toBe("ALLOWED");
    expect(hubAccessBody.permissions).toContain("organization.read");

    const combinedMe = await request(cookies, "/api/auth/me");
    expect(combinedMe.status).toBe(200);
    const combinedMeBody = await combinedMe.json() as { access?: { allowed?: boolean; reason?: string; permissions?: string[] } };
    expect(combinedMeBody.access?.allowed).toBe(true);
    expect(combinedMeBody.access?.reason).toBe("ALLOWED");
    expect(combinedMeBody.access?.permissions).toContain("organization.read");

    const organizationSettings = await request(cookies, `/api/v1/hub/organizations/${encodeURIComponent(organizationBody.organizationId ?? "")}`);
    expect(organizationSettings.status).toBe(200);

    const resolvedEntitlements = await request(cookies, "/api/v1/me/entitlements");
    expect(resolvedEntitlements.status).toBe(200);
    const resolvedBody = await resolvedEntitlements.json() as {
      entitlements?: {
        planId?: string;
        status?: string;
        limits?: Record<string, number | null>;
        usage?: Record<string, number>;
      };
    };
    expect(resolvedBody.entitlements?.planId).toBe("starter");
    expect(resolvedBody.entitlements?.status).toBe("ACTIVE");
    expect(resolvedBody.entitlements?.limits?.store_application_bindings).toBe(1);
    expect(resolvedBody.entitlements?.usage?.store_application_bindings).toBe(0);

    const enabledFeature = await request(cookies, "/api/v1/hub/entitlements/pos/check");
    expect(enabledFeature.status).toBe(200);
    const enabledBody = await enabledFeature.json() as { allowed?: boolean; reason?: string; projectionVersion?: string };
    expect(enabledBody.allowed).toBe(true);
    expect(enabledBody.reason).toBe("ALLOWED");
    expect(enabledBody.projectionVersion).toBe("organization-entitlements-v1");

    const freeTierFeature = await request(cookies, "/api/v1/hub/entitlements/kiosk/check");
    expect(freeTierFeature.status).toBe(200);
    const freeTierBody = await freeTierFeature.json() as { allowed?: boolean; reason?: string };
    expect(freeTierBody.allowed).toBe(true);
    expect(freeTierBody.reason).toBe("ALLOWED");

    const store = await request(cookies, "/api/v1/hub/onboarding/store", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        name: "Entitlement Test Store",
        code: `ENT-${timestamp}`
      })
    });
    expect(store.status).toBe(200);
    const storeBody = await store.json() as { storeId?: string };
    expect(storeBody.storeId).toBeTruthy();

    const customerProfiles = await request(cookies, "/api/v1/hub/stores/customer-profiles");
    expect(customerProfiles.status).toBe(200);
    const customerProfilesBody = await customerProfiles.json() as { profiles?: unknown[] };
    expect(Array.isArray(customerProfilesBody.profiles)).toBe(true);

    const memberAssignments = await request(cookies, "/api/v1/hub/members/applications");
    expect(memberAssignments.status).toBe(200);
    const memberAssignmentsBody = await memberAssignments.json() as { assignments?: unknown[] };
    expect(Array.isArray(memberAssignmentsBody.assignments)).toBe(true);

    const storeFeature = await request(cookies, `/api/v1/hub/entitlements/pos/check?storeId=${encodeURIComponent(storeBody.storeId ?? "")}`);
    expect(storeFeature.status).toBe(200);
    const storeFeatureBody = await storeFeature.json() as { allowed?: boolean; reason?: string };
    expect(storeFeatureBody.allowed).toBe(false);
    expect(storeFeatureBody.reason).toBe("STORE_APPLICATION_DISABLED");

    const hubProxyBeforeAssignment = await request(cookies, "/api/v1/access?application=POS");
    expect(hubProxyBeforeAssignment.status).toBe(200);
    const hubProxyBeforeBody = await hubProxyBeforeAssignment.json() as { allowed?: boolean; reason?: string };
    expect(hubProxyBeforeBody.allowed).toBe(false);
    expect(hubProxyBeforeBody.reason).toBe("APP_ASSIGNMENT_REQUIRED");

    const launchBeforeAssignment = await request(cookies, "/api/v1/hub/applications/POS/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storeId: storeBody.storeId })
    });
    expect(launchBeforeAssignment.status).toBe(403);
    const launchBeforeBody = await launchBeforeAssignment.json() as { error?: { code?: string } };
    expect(launchBeforeBody.error?.code).toBe("APP_ASSIGNMENT_REQUIRED");

    const appSetup = await request(cookies, "/api/v1/hub/onboarding/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, applications: ["POS"] })
    });
    expect(appSetup.status).toBe(200);

    const hubProxyAfterAssignment = await request(cookies, "/api/v1/access?application=POS");
    expect(hubProxyAfterAssignment.status).toBe(200);
    const hubProxyAfterBody = await hubProxyAfterAssignment.json() as { allowed?: boolean; reason?: string };
    expect(hubProxyAfterBody.allowed).toBe(true);
    expect(hubProxyAfterBody.reason).toBe("ALLOWED");

    const subscriptions = await request(cookies, "/api/v1/hub/subscriptions");
    expect(subscriptions.status).toBe(200);
    const subscriptionsBody = await subscriptions.json() as {
      subscriptions?: Array<{
        appId?: string;
        planCode?: string;
        isEntitled?: boolean;
        currentPeriodEndsAt?: string | null;
        daysRemaining?: number | null;
      }>;
    };
    const posSubscription = subscriptionsBody.subscriptions?.find((subscription) => subscription.appId === "pos");
    expect(posSubscription?.planCode).toBe("starter");
    expect(posSubscription?.isEntitled).toBe(true);
    expect(posSubscription?.currentPeriodEndsAt).toBeNull();
    expect(posSubscription?.daysRemaining).toBeNull();

    const enabledStoreFeature = await request(cookies, `/api/v1/hub/entitlements/pos/check?storeId=${encodeURIComponent(storeBody.storeId ?? "")}`);
    expect(enabledStoreFeature.status).toBe(200);
    const enabledStoreFeatureBody = await enabledStoreFeature.json() as {
      allowed?: boolean;
      reason?: string;
      quotaLimitValue?: number;
      quotaUsage?: number;
    };
    expect(enabledStoreFeatureBody.allowed).toBe(true);
    expect(enabledStoreFeatureBody.reason).toBe("ALLOWED");
    expect(enabledStoreFeatureBody.quotaLimitValue).toBe(1);
    expect(enabledStoreFeatureBody.quotaUsage).toBe(1);

    const operatingMode = await request(cookies, "/api/v1/hub/operating-mode");
    expect(operatingMode.status).toBe(200);
    const operatingModeBody = await operatingMode.json() as { isUnlimitedTesting?: boolean; authorizationBypass?: boolean };
    expect(operatingModeBody.isUnlimitedTesting).toBe(false);
    expect(operatingModeBody.authorizationBypass).toBe(false);
  }, 30_000);

  it("rejects conflicting tenant headers and blocks a revoked session", async () => {
    const cookies: CookieMap = new Map();
    const timestamp = Date.now();
    const registration = await request(cookies, "/api/v1/hub/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `tenant.headers.${timestamp}@aevo.test`,
        password: "AevoDev!TenantHeaders2026#",
        fullName: "Tenant Header Test"
      })
    });
    expect(registration.status).toBe(200);

    const conflictingHeaders = await request(cookies, "/api/auth/me", {
      headers: {
        "x-tenant-id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "x-organization-id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
      }
    });
    expect(conflictingHeaders.status).toBe(400);
    const conflictBody = await conflictingHeaders.json() as { error?: { code?: string } };
    expect(conflictBody.error?.code).toBe("TENANT_CONTEXT_CONFLICT");

    const logout = await request(cookies, "/api/auth/logout", { method: "POST" });
    expect(logout.status).toBe(204);

    const revokedSession = await request(cookies, "/api/auth/me");
    expect(revokedSession.status).toBe(401);
  }, 30_000);

  it("keeps remember-me opt-in and binds login to the Edge application context", async () => {
    const cookies: CookieMap = new Map();
    const timestamp = Date.now();
    const email = `remember.security.${timestamp}@aevo.test`;
    const password = "AevoDev!Remember2026#";
    const registration = await request(cookies, "/api/v1/hub/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, fullName: "Remember Security Test", rememberMe: true })
    });
    expect(registration.status).toBe(200);
    const sessionCookie = registration.headers.getSetCookie?.().find((header) => header.startsWith("aevo_hub_session="));
    expect(sessionCookie).toContain("Max-Age=");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");

    const rememberedMe = await request(cookies, "/api/auth/me");
    expect(rememberedMe.status).toBe(200);
    const rememberedBody = await rememberedMe.json() as { session?: { rememberMe?: boolean } };
    expect(rememberedBody.session?.rememberMe).toBe(true);

    const refresh = await request(cookies, "/api/auth/refresh", { method: "POST" });
    expect(refresh.status).toBe(200);
    const refreshedCookie = refresh.headers.getSetCookie?.().find((header) => header.startsWith("aevo_hub_session="));
    expect(refreshedCookie).toContain("Max-Age=");

    const refreshedMe = await request(cookies, "/api/auth/me");
    expect(refreshedMe.status).toBe(200);
    const refreshedBody = await refreshedMe.json() as { session?: { rememberMe?: boolean } };
    expect(refreshedBody.session?.rememberMe).toBe(true);

    const logout = await request(cookies, "/api/auth/logout", { method: "POST" });
    expect(logout.status).toBe(204);

    // The browser cannot select another first-party application by putting an
    // application field in the JSON body. Edge's signed HUB context wins.
    const login = await request(cookies, "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, application: "ADMIN", rememberMe: false })
    });
    expect(login.status).toBe(200);
    const loginBody = await login.json() as { appCode?: string; session?: { rememberMe?: boolean } };
    expect(loginBody.appCode).toBe("HUB");
    expect(loginBody.session?.rememberMe).toBe(false);
    expect(cookies.get("aevo_hub_session")).toBeTruthy();
    expect(cookies.get("aevo_admin_session")).toBeUndefined();
    const nonPersistentCookie = login.headers.getSetCookie?.().find((header) => header.startsWith("aevo_hub_session="));
    expect(nonPersistentCookie).not.toContain("Max-Age=");
  }, 30_000);

  it("keeps a store-scoped application assignment inside the assigned store", async () => {
    const ownerCookies: CookieMap = new Map();
    const memberCookies: CookieMap = new Map();
    const timestamp = Date.now();

    const ownerRegistration = await request(ownerCookies, "/api/v1/hub/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `store.scope.owner.${timestamp}@aevo.test`,
        password: "AevoDev!StoreScopeOwner2026#",
        fullName: "Store Scope Owner"
      })
    });
    expect(ownerRegistration.status).toBe(200);

    const onboarding = await request(ownerCookies, "/api/v1/hub/onboarding/session");
    expect(onboarding.status).toBe(200);
    const onboardingBody = await onboarding.json() as { session?: { id?: string } };
    const sessionId = onboardingBody.session?.id;
    expect(sessionId).toBeTruthy();

    const organization = await request(ownerCookies, "/api/v1/hub/onboarding/organization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        name: `Store Scope ${timestamp}`,
        slug: `store-scope-${timestamp}`
      })
    });
    expect(organization.status).toBe(200);
    const organizationBody = await organization.json() as { organizationId?: string };
    const organizationId = organizationBody.organizationId;
    expect(organizationId).toBeTruthy();

    const createStore = async (name: string, code: string): Promise<string> => {
      const response = await request(ownerCookies, "/api/v1/hub/stores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, code })
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { store?: { id?: string } };
      expect(body.store?.id).toBeTruthy();
      return body.store?.id ?? "";
    };

    const assignedStoreId = await createStore("Assigned Store", `SCOPE-A-${timestamp}`);
    const otherStoreId = await createStore("Other Store", `SCOPE-B-${timestamp}`);

    const firstEnable = await request(ownerCookies, `/api/v1/hub/stores/${assignedStoreId}/applications/POS`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    expect(firstEnable.status).toBe(200);

    const secondEnable = await request(ownerCookies, `/api/v1/hub/stores/${otherStoreId}/applications/POS`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    expect(secondEnable.status).toBe(403);
    const secondEnableBody = await secondEnable.json() as { error?: { code?: string } };
    expect(secondEnableBody.error?.code).toBe("ENTITLEMENT_LIMIT_EXCEEDED");

    const idempotencyKey = `store-binding-retry-${timestamp}`;
    const firstProvision = await request(ownerCookies, `/api/v1/hub/stores/${assignedStoreId}/applications/POS`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ enabled: true })
    });
    expect(firstProvision.status).toBe(200);
    const firstProvisionBody = await firstProvision.json() as { application?: { status?: string } };
    expect(firstProvisionBody.application?.status).toBe("ACTIVE");

    const retriedProvision = await request(ownerCookies, `/api/v1/hub/stores/${assignedStoreId}/applications/POS`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ enabled: true })
    });
    expect(retriedProvision.status).toBe(200);
    const retriedProvisionBody = await retriedProvision.json() as { application?: { status?: string } };
    expect(retriedProvisionBody.application?.status).toBe("ACTIVE");

    const conflictingProvision = await request(ownerCookies, `/api/v1/hub/stores/${assignedStoreId}/applications/POS`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ enabled: false })
    });
    expect(conflictingProvision.status).toBe(409);
    const conflictingProvisionBody = await conflictingProvision.json() as { error?: { code?: string } };
    expect(conflictingProvisionBody.error?.code).toBe("HUB_STORE_APPLICATION_IDEMPOTENCY_CONFLICT");

    const memberRegistration = await request(memberCookies, "/api/v1/hub/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `store.scope.member.${timestamp}@aevo.test`,
        password: "AevoDev!StoreScopeMember2026#",
        fullName: "Store Scope Member"
      })
    });
    expect(memberRegistration.status).toBe(200);

    const member = await request(ownerCookies, "/api/v1/hub/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `store.scope.member.${timestamp}@aevo.test`,
        role: "ADMIN",
        applicationCodes: [],
        storeIds: []
      })
    });
    expect(member.status).toBe(200);
    const memberBody = await member.json() as { member?: { membershipId?: string } };
    const membershipId = memberBody.member?.membershipId;
    expect(membershipId).toBeTruthy();

    const assignment = await request(ownerCookies, `/api/v1/hub/members/${membershipId}/applications/POS`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ACTIVE", storeIds: [assignedStoreId] })
    });
    expect(assignment.status).toBe(200);

    const assignedAccess = await request(memberCookies, `/api/v1/access?application=POS&organizationId=${organizationId}&storeId=${assignedStoreId}`);
    expect(assignedAccess.status).toBe(200);
    const assignedBody = await assignedAccess.json() as { allowed?: boolean; reason?: string };
    expect(assignedBody.allowed).toBe(true);
    expect(assignedBody.reason).toBe("ALLOWED");

    const otherAccess = await request(memberCookies, `/api/v1/access?application=POS&organizationId=${organizationId}&storeId=${otherStoreId}`);
    expect(otherAccess.status).toBe(200);
    const otherBody = await otherAccess.json() as { allowed?: boolean; reason?: string };
    expect(otherBody.allowed).toBe(false);
    expect(otherBody.reason).toBe("APP_ASSIGNMENT_REQUIRED");
  }, 45_000);

  it("keeps typed store application configuration Core-owned and non-secret", async () => {
    const cookies: CookieMap = new Map();
    const timestamp = Date.now();
    const registration = await request(cookies, "/api/v1/hub/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `typed.config.${timestamp}@aevo.test`,
        password: "AevoDev!TypedConfig2026#",
        fullName: "Typed Config Test"
      })
    });
    expect(registration.status).toBe(200);

    const onboarding = await request(cookies, "/api/v1/hub/onboarding/session");
    expect(onboarding.status).toBe(200);
    const sessionBody = await onboarding.json() as { session?: { id?: string } };
    const sessionId = sessionBody.session?.id;
    expect(sessionId).toBeTruthy();

    const organization = await request(cookies, "/api/v1/hub/onboarding/organization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        name: `Typed Config ${timestamp}`,
        slug: `typed-config-${timestamp}`
      })
    });
    expect(organization.status).toBe(200);

    const store = await request(cookies, "/api/v1/hub/onboarding/store", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, name: "Typed Config Store", code: `TC-${timestamp}` })
    });
    expect(store.status).toBe(200);
    const storeBody = await store.json() as { storeId?: string };
    const storeId = storeBody.storeId;
    expect(storeId).toBeTruthy();

    const enable = await request(cookies, `/api/v1/hub/stores/${storeId}/applications/POS`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    expect(enable.status).toBe(200);

    const configuration = await request(cookies, `/api/v1/hub/stores/${storeId}/applications/POS/config`);
    expect(configuration.status).toBe(200);
    const configurationBody = await configuration.json() as { configuration?: { schemas?: Array<{ schemaRef?: string; schemaVersion?: string }> } };
    const catalogSchema = configurationBody.configuration?.schemas?.find((schema) => schema.schemaRef === "pos.catalog.v1");
    expect(catalogSchema?.schemaVersion).toBe("1");

    const secret = await request(cookies, `/api/v1/hub/stores/${storeId}/applications/POS/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaRef: "pos.catalog.v1",
        schemaVersion: catalogSchema?.schemaVersion,
        config: { catalogChannel: "POS", allowPriceOverride: false, outOfStockMode: "HIDE", secretToken: "blocked" }
      })
    });
    expect(secret.status).toBe(400);
    const secretBody = await secret.json() as { error?: { code?: string } };
    expect(secretBody.error?.code).toBe("PLAINTEXT_SECRET_FORBIDDEN");

    const wrongScope = await request(cookies, `/api/v1/hub/stores/${storeId}/applications/POS/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaRef: "booking.v1",
        schemaVersion: "1",
        config: { bookingEnabled: true }
      })
    });
    expect(wrongScope.status).toBe(400);
    const wrongScopeBody = await wrongScope.json() as { error?: { code?: string } };
    expect(wrongScopeBody.error?.code).toBe("CONFIGURATION_SCOPE_MISMATCH");

    const save = await request(cookies, `/api/v1/hub/stores/${storeId}/applications/POS/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaRef: "pos.catalog.v1",
        schemaVersion: catalogSchema?.schemaVersion,
        config: { catalogChannel: "QR", allowPriceOverride: true, outOfStockMode: "SHOW_SOLD_OUT" }
      })
    });
    expect(save.status).toBe(200);
    const savedBody = await save.json() as { configuration?: { schemas?: Array<{ schemaRef?: string; config?: Record<string, unknown> }> } };
    const savedSchema = savedBody.configuration?.schemas?.find((schema) => schema.schemaRef === "pos.catalog.v1");
    expect(savedSchema?.config?.catalogChannel).toBe("QR");
    expect(savedSchema?.config?.allowPriceOverride).toBe(true);

    const template = await request(cookies, "/api/v1/hub/store-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Typed Config Template ${timestamp}`, sourceStoreId: storeId })
    });
    expect(template.status).toBe(200);
    const templateBody = await template.json() as { template?: { id?: string } };
    expect(templateBody.template?.id).toBeTruthy();

    const duplicate = await request(cookies, `/api/v1/hub/store-templates/${templateBody.template?.id}/instantiate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Typed Config Child", code: `TCC-${timestamp}` })
    });
    expect(duplicate.status).toBe(200);
    const duplicateBody = await duplicate.json() as { store?: { id?: string } };
    expect(duplicateBody.store?.id).toBeTruthy();
    const duplicateConfig = await request(cookies, `/api/v1/hub/stores/${duplicateBody.store?.id}/applications/POS/config`);
    expect(duplicateConfig.status).toBe(200);
    const duplicateConfigBody = await duplicateConfig.json() as { configuration?: { schemas?: Array<{ schemaRef?: string; config?: Record<string, unknown> }> } };
    const duplicateSchema = duplicateConfigBody.configuration?.schemas?.find((schema) => schema.schemaRef === "pos.catalog.v1");
    expect(duplicateSchema?.config?.catalogChannel).toBe("QR");

    const disable = await request(cookies, `/api/v1/hub/stores/${storeId}/applications/POS`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    expect(disable.status).toBe(200);

    const disabledWrite = await request(cookies, `/api/v1/hub/stores/${storeId}/applications/POS/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaRef: "pos.catalog.v1",
        schemaVersion: catalogSchema?.schemaVersion,
        config: { catalogChannel: "POS", allowPriceOverride: false, outOfStockMode: "HIDE" }
      })
    });
    expect(disabledWrite.status).toBe(409);
    const disabledBody = await disabledWrite.json() as { error?: { code?: string } };
    expect(disabledBody.error?.code).toBe("STORE_APPLICATION_DISABLED");
  }, 30_000);
});
