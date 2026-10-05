import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const reportsRoute = resolve(import.meta.dir, "../apps/hub/app/routes/reports.tsx");
const capabilityModule = resolve(import.meta.dir, "../apps/hub/app/lib/platform-capabilities.ts");

describe("Hub Query Platform phase one contract", () => {
  it("keeps reports server-wired to Core metadata and bounded execution", async () => {
    const source = await readFile(reportsRoute, "utf8");

    expect(source).toContain('"/api/v1/query/models"');
    expect(source).toContain('"/api/v1/query/execute"');
    expect(source).toContain('"store.read"');
    expect(source).toContain("pagination: { limit: query.pageSize, offset: (query.page - 1) * query.pageSize }");
    expect(source).toContain("const allowedPageSizes = [10, 25, 50, 100] as const");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });

  it("keeps export and import unavailable states explicit until Core workers exist", async () => {
    const source = await readFile(reportsRoute, "utf8");
    const capabilities = await readFile(capabilityModule, "utf8");

    expect(source).toContain('"/api/v1/query/exports"');
    expect(source).toContain("requestCsrfHeaders(request)");
    expect(source).toContain("idempotencyKey(rawQuery)");
    expect(source).toContain("EXPORT_WORKER_NOT_CONFIGURED");
    expect(source).toContain("IMPORT_WORKER_NOT_CONFIGURED");
    expect(capabilities).toContain("CORE_IMPORT_CAPABILITY_NOT_EXPOSED");
    expect(capabilities).toContain("CORE_EXPORT_CAPABILITY_NOT_EXPOSED");
    expect(source).not.toContain("downloadUrl");
  });
});
