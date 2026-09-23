import { describe, expect, it } from "bun:test";

const edgeUrl = process.env.EDGE_URL?.trim()
  || process.env.API_URL?.trim()
  || "http://localhost:4000";
const coreUrl = process.env.CORE_URL?.trim() || "http://localhost:5099";

describe("Aevo Core API through the Edge boundary", () => {
  it("serves the versioned Hub contract through Edge", async () => {
    const response = await fetch(`${edgeUrl}/api/v1/hub/contract`, {
      headers: { "x-aevo-contract-version": "v1" }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-aevo-contract-version")).toBe("v1");

    const body = await response.json() as {
      service?: string;
      routeCount?: number;
      implementedRouteCount?: number;
      implementationStatus?: string;
    };
    expect(body.service).toBe("aevo-core-api");
    expect(body.routeCount).toBe(48);
    expect(body.implementedRouteCount).toBe(48);
    expect(body.implementationStatus).toBe("ready");
  });

  it("keeps Core private when the Edge signature is absent", async () => {
    const response = await fetch(`${coreUrl}/api/v1/hub/contract`, {
      headers: { "x-aevo-contract-version": "v1" }
    });
    expect(response.status).toBe(403);
  });

  it("fails closed for anonymous Hub access and onboarding mutations", async () => {
    const access = await fetch(`${edgeUrl}/api/v1/access?application=HUB`);
    expect(access.status).toBe(401);

    const onboarding = await fetch(`${edgeUrl}/api/v1/hub/onboarding/organization`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "anonymous" })
    });
    expect(onboarding.status).toBe(401);
  });
});
