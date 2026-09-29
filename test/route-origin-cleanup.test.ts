import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "../..");

async function source(relativePath: string): Promise<string> {
  return readFile(resolve(workspaceRoot, relativePath), "utf8");
}

test("Hub runtime uses the modern origin and browser route contract", async () => {
  const edgeSource = await source("aevo-edge-gateway/src/index.ts");
  const edgeExample = await source("aevo-edge-gateway/.env.example");
  const coreEndpoints = await source("aevo-core-api/src/Aevo.CoreApi/HubApiEndpoints.cs");
  const adminNavigationContract = await source("aevo-admin/packages/contracts/src/index.ts");
  const hubSettings = await source("aevo-hub/apps/hub/app/routes/settings.tsx");
  const hubStore = await source("aevo-hub/apps/hub/app/routes/store.tsx");

  expect(edgeSource).not.toContain("http://localhost:4321");
  expect(edgeSource).not.toContain("http://127.0.0.1:4321");
  expect(edgeExample).not.toContain("localhost:4321");
  expect(coreEndpoints).not.toContain("/modern/organize");
  expect(coreEndpoints).not.toContain('"/organize');
  expect(coreEndpoints).not.toContain('"/workspace');
  expect(adminNavigationContract).not.toContain('href: "/organize');
  expect(adminNavigationContract).not.toContain('href: "/workspace');
  expect(hubSettings).toContain("/api/v1/hub/applications/");
  expect(hubSettings).not.toContain("applicationUrl");
  expect(hubSettings).not.toContain("href={access.url");
  expect(hubStore).toContain('intent\" value=\"launch-application');
});
