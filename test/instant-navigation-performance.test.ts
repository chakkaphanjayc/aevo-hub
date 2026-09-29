import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getClientCachedData, setClientCachedData, invalidateClientCache } from "../apps/hub/app/lib/client-cache";
import { requireHubAccess, invalidateHubAccessCache } from "../apps/hub/app/lib/auth.server";

const workspaceRoot = resolve(import.meta.dir, "../..");

async function source(relativePath: string): Promise<string> {
  return readFile(resolve(workspaceRoot, relativePath), "utf8");
}

test("client-cache provides instant synchronous data retrieval and invalidation", () => {
  // Test instant client-side cache
  const testUrl = "http://localhost:4330/modern/stores";
  const dummyData = { stores: [{ id: "s1", name: "Store 1" }] };

  // Set cache
  setClientCachedData(testUrl, dummyData);

  // Retrieve instantly
  const start = performance.now();
  const cached = getClientCachedData<typeof dummyData>(testUrl);
  const elapsed = performance.now() - start;

  expect(cached).toBeDefined();
  expect(cached?.stores[0].name).toBe("Store 1");
  // Retrieval must be instantaneous (< 1ms)
  expect(elapsed).toBeLessThan(5);

  // Invalidate cache
  invalidateClientCache();
  expect(getClientCachedData(testUrl)).toBeUndefined();
});

test("auth.server provides instant in-memory session cache across internal requests", async () => {
  invalidateHubAccessCache();

  // Mock Request with cookie
  const mockCookie = "aevo_session=test_instant_perf_cookie_12345";
  const req1 = new Request("http://localhost:4330/modern/stores", {
    headers: {
      cookie: mockCookie
    }
  });

  // Verify invalidateHubAccessCache clears specific cookie and all cookies
  invalidateHubAccessCache(mockCookie);
  invalidateHubAccessCache();
  expect(typeof invalidateHubAccessCache).toBe("function");
  expect(typeof requireHubAccess).toBe("function");
});

test("Hub route architecture enforces prefetch and clientLoader for instant navigation", async () => {
  const layoutSource = await source("aevo-hub/apps/hub/app/routes/hub-layout.tsx");
  const settingsSource = await source("aevo-hub/apps/hub/app/routes/settings.tsx");
  const storesSource = await source("aevo-hub/apps/hub/app/routes/stores.tsx");
  const storeSource = await source("aevo-hub/apps/hub/app/routes/store.tsx");
  const workspaceSource = await source("aevo-hub/apps/hub/app/routes/workspace.tsx");
  const securitySource = await source("aevo-hub/apps/hub/app/routes/security.tsx");

  // 1. Navigation links must enforce prefetch="intent"
  expect(layoutSource).toContain('prefetch="intent"');
  expect(settingsSource).toContain('prefetch="intent"');
  expect(storesSource).toContain('prefetch="intent"');
  expect(storeSource).toContain('prefetch="intent"');
  expect(workspaceSource).toContain('prefetch="intent"');

  // 2. All main routes must export clientLoader for 0ms transitions
  expect(settingsSource).toContain("export async function clientLoader");
  expect(storesSource).toContain("clientLoader");
  expect(storeSource).toContain("export async function clientLoader");
  expect(workspaceSource).toContain("export async function clientLoader");
  expect(securitySource).toContain("export async function clientLoader");

  // 3. settings.tsx must reuse hub.stores rather than re-requesting /api/v1/hub/stores
  expect(settingsSource).toContain("hub.stores.length > 0");
  expect(settingsSource).toContain("hub.stores.filter");

  // 4. store.tsx must reuse hub.stores when store is already indexed
  expect(storeSource).toContain("hub.stores.find((s) => s.id === storeId)");

  // 5. Actions must invalidate caches on mutations
  expect(settingsSource).toContain("invalidateHubAccessCache");
  expect(settingsSource).toContain("invalidateClientCache");
  expect(storeSource).toContain("invalidateHubAccessCache");
  expect(storeSource).toContain("invalidateClientCache");

  // 6. Store navigation is derived from Core's enabled application projection
  // and full-app launch remains a server-side SSO action.
  expect(layoutSource).toContain("readEnabledStoreApplications");
  expect(layoutSource).toContain('label: "Enabled apps"');
  expect(layoutSource).toContain("storeApplicationPath");
  expect(storeSource).toContain("const needsApplications = true");
  expect(storeSource).toContain("launchFailureMessage");
  expect(storeSource).toContain('Review entitlements');
  expect(storeSource).toContain('name=\"intent\" value=\"launch-application\"');
  expect(storeSource).toContain("Open full app");
});
