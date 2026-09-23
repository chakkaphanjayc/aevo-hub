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
    const meBody = await me.json() as { user?: { email?: string }; principal?: unknown };
    expect(meBody.user?.email).toContain("@aevo.test");
    expect(meBody.principal).toBeNull();

    const onboarding = await request(cookies, "/api/v1/hub/onboarding/session");
    expect(onboarding.status).toBe(200);
    const onboardingBody = await onboarding.json() as { session?: { userId?: string; isCompleted?: boolean } };
    expect(onboardingBody.session?.userId).toBeTruthy();
    expect(onboardingBody.session?.isCompleted).toBe(false);

    const foreignOrganization = await request(cookies, `/api/v1/hub/organizations/${crypto.randomUUID()}`);
    expect([403, 404]).toContain(foreignOrganization.status);
  }, 30_000);
});
