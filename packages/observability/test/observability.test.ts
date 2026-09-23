import { describe, expect, test } from "bun:test";
import { createReleaseMetadata, createRequestId, normalizeRequestId, toLogContext } from "../src";

describe("@aevocado/observability", () => {
  test("normalizes trusted request ids and rejects header injection", () => {
    expect(normalizeRequestId(" request-123 ")).toBe("request-123");
    expect(normalizeRequestId("bad\nrequest")).toBeUndefined();
    expect(normalizeRequestId(" ")).toBeUndefined();
  });

  test("creates release and structured request context", () => {
    const release = createReleaseMetadata({ appName: "hub-gateway", appVersion: "2026.09.19", environment: "production" });
    expect(release).toEqual({ appName: "hub-gateway", appVersion: "2026.09.19", environment: "production" });
    const context = toLogContext({
      requestId: createRequestId(),
      ...release,
      organizationId: "org-1",
      route: "/api/v1/hub/bootstrap"
    });
    expect(context.app_name).toBe("hub-gateway");
    expect(context.organization_id).toBe("org-1");
    expect(context.request_id).toBeTruthy();
  });
});
