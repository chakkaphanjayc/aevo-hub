import { beforeAll, describe, expect, it } from "bun:test";
import { createAevoClient, GatewayError } from "../packages/sdk/src";

const GATEWAY_URL = process.env.API_URL || "http://localhost:4000";

async function expectGatewayStatus(operation: () => Promise<unknown>, status: number): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    if (error instanceof GatewayError) expect(error.status).toBe(status);
    return;
  }
  throw new Error(`Expected gateway status ${status}`);
}

describe("Aevo canonical gateway surfaces", () => {
  const timestamp = Date.now();
  const client = createAevoClient({ baseUrl: GATEWAY_URL });
  let organizationId: string;
  let storeId: string;
  let storeCode: string;

  beforeAll(async () => {
    const email = `gateway.owner.${timestamp}@aevo.test`;
    const registration = await client.hub.onboarding.register({
      email,
      password: "Password123!",
      fullName: "Gateway Flow Owner"
    });

    await client.auth.login({ email, password: "Password123!" });

    await client.hub.onboarding.setObjectives({
      sessionId: registration.session.id,
      objectives: ["pos", "booking"]
    });

    const organization = await client.hub.onboarding.setupOrganization({
      sessionId: registration.session.id,
      name: `Gateway Test Organization ${timestamp}`,
      businessType: "sport_venue",
      country: "TH",
      timezone: "Asia/Bangkok",
      currency: "THB"
    });
    organizationId = organization.organizationId;
    client.setOrganizationId(organizationId);

    const store = await client.hub.onboarding.setupStore({
      sessionId: registration.session.id,
      organizationId,
      name: "Gateway Test Store",
      code: `GTW-${String(timestamp).slice(-6)}`,
      storeMode: "POS_BOOKING"
    });
    storeId = store.storeId;
    client.setStoreId(storeId);

    await client.hub.onboarding.setupApps({
      sessionId: registration.session.id,
      organizationId,
      appIds: ["pos", "booking"]
    });

    const stores = await client.hub.listStores(organizationId);
    const currentStore = stores.find((candidate) => candidate.id === storeId);
    if (!currentStore) throw new Error("Canonical gateway test store was not created");
    storeCode = currentStore.code;
  }, 30_000);

  it("serves health and the public app catalog", async () => {
    const health = await fetch(`${GATEWAY_URL}/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json() as { status?: string; service?: string };
    expect(healthBody.status).toBe("healthy");
    expect(healthBody.service).toBe("aevo-canonical-gateway");

    const apps = await client.hub.listApps();
    expect(apps.length).toBeGreaterThanOrEqual(7);
    expect(apps.map((app) => app.id)).toEqual(expect.arrayContaining(["pos", "kiosk", "booking"]));

    const queryModels = await client.query.listModels();
    expect(queryModels.models.map((model) => model.technical_name)).toEqual(expect.arrayContaining([
      "product.product",
      "sale.order",
      "res.store"
    ]));
    const parsed = await client.query.parse("name:sample AND (sku:GTW OR sku:TEST)");
    expect(parsed.where?.type).toBe("and");
    const queryResult = await client.query.execute({
      query: {
        version: 1,
        model: "product.product",
        fields: ["name", "sku"],
        pagination: { limit: 10, offset: 0 }
      },
      searchText: "name:sample"
    });
    expect(queryResult.model).toBe("product.product");
    expect(queryResult.total).toBeGreaterThanOrEqual(0);

    const relationResult = await client.query.execute({
      query: {
        version: 1,
        model: "product.product",
        where: { type: "condition", field: "category.name", operator: "contains", value: "no matching category" },
        fields: ["name", "category.name"],
        pagination: { limit: 10, offset: 0 }
      }
    });
    expect(relationResult.total).toBe(0);

    const aggregateResult = await client.query.execute({
      query: {
        version: 1,
        model: "product.product",
        fields: ["name", "base_price_minor"],
        aggregates: [{ function: "count", alias: "product_count" }],
        pagination: { limit: 10, offset: 0 }
      }
    });
    expect(aggregateResult.aggregates).toHaveProperty("product_count");
  }, 45_000);

  it("uses the application session for identity and tenant data", async () => {
    const me = await client.auth.me();
    expect(me.user.email).toContain("@aevo.test");
    expect(me.principal?.organizationId).toBe(organizationId);

    const organizations = await client.hub.listOrganizations();
    expect(organizations.some((organization) => organization.id === organizationId)).toBe(true);

    const stores = await client.hub.listStores(organizationId);
    expect(stores.some((store) => store.id === storeId)).toBe(true);
  }, 15_000);

  it("manages stores, members, and devices through authenticated hub APIs", async () => {
    const temporaryStore = await client.hub.createStore({
      organizationId,
      name: "Temporary Gateway Store",
      code: `TMP-${String(timestamp).slice(-6)}`,
      timezone: "Asia/Bangkok"
    });
    const updatedStore = await client.hub.updateStore(temporaryStore.store.id, {
      name: "Updated Gateway Store"
    });
    expect(updatedStore.store.name).toBe("Updated Gateway Store");
    await client.hub.deleteStore(temporaryStore.store.id);

    const member = await client.hub.addMember({
      email: `gateway.staff.${timestamp}@aevo.test`,
      displayName: "Gateway Test Staff",
      role: "STAFF",
      storeIds: [storeId]
    });
    expect(member.member.role).toBe("STAFF");
    await client.hub.deleteMember(member.member.membershipId);

    const device = await client.hub.createDevicePairing({
      storeId,
      name: "Gateway Test Kiosk",
      mode: "KIOSK"
    });
    expect(device.pairingCode).toHaveLength(8);
    await client.hub.revokeDevice(device.device.id);
  }, 60_000);

  it("serves staff, public, and tenant operations from the same session", async () => {
    const context = await client.staff.getContext(storeId);
    expect(context.currentStore?.id).toBe(storeId);

    const catalog = await client.staff.getCatalog(storeId);
    expect(catalog).toBeDefined();

    const subscriptions = await client.hub.getSubscriptions(storeId);
    expect(subscriptions.subscriptions.some((subscription) => subscription.appId === "pos")).toBe(true);
    const posEntitlement = await client.hub.getEntitlement("pos", storeId);
    expect(posEntitlement.entitlement.isEntitled).toBe(true);

    const menu = await client.public.getMenu(storeCode);
    expect(menu).toBeDefined();

    const removedSqlSurface = await fetch(`${GATEWAY_URL}/api/v1/hub/sql`, { method: "POST" });
    expect(removedSqlSurface.status).toBe(404);
  }, 20_000);

  it("runs validated import previews and export jobs through the query platform", async () => {
    const importJob = await client.dataJobs.previewImport({
      model: "product.product",
      sourceFileName: `gateway-query-${timestamp}.csv`,
      sourceContentType: "text/csv",
      idempotencyKey: `gateway-query-${timestamp}`,
      columns: ["sku", "name", "base_price_minor"],
      rows: [
        { sku: `QRY-${timestamp}`, name: "Query Preview Product", base_price_minor: "1250" },
        { sku: `QRY-INVALID-${timestamp}`, name: "", base_price_minor: "not-a-number" }
      ]
    });
    expect(importJob.importJob.status).toBe("READY");
    expect(importJob.importJob.total_rows).toBe(2);
    expect(importJob.importJob.valid_rows).toBe(1);
    expect(importJob.importJob.failed_rows).toBe(1);

    const replayedImport = await client.dataJobs.previewImport({
      model: "product.product",
      sourceFileName: `gateway-query-${timestamp}.csv`,
      sourceContentType: "text/csv",
      idempotencyKey: `gateway-query-${timestamp}`,
      columns: ["sku", "name", "base_price_minor"],
      rows: [
        { sku: `QRY-${timestamp}`, name: "Query Preview Product", base_price_minor: "1250" },
        { sku: `QRY-INVALID-${timestamp}`, name: "", base_price_minor: "not-a-number" }
      ]
    });
    expect(replayedImport.importJob.id).toBe(importJob.importJob.id);
    await expectGatewayStatus(() => client.dataJobs.previewImport({
      model: "product.product",
      sourceFileName: `gateway-query-${timestamp}.csv`,
      sourceContentType: "text/csv",
      idempotencyKey: `gateway-query-${timestamp}`,
      columns: ["sku", "name", "base_price_minor"],
      rows: [{ sku: `QRY-DIFFERENT-${timestamp}`, name: "Different payload", base_price_minor: "1250" }]
    }), 409);

    const reloadedImport = await client.dataJobs.getImport(importJob.importJob.id);
    expect(reloadedImport.importJob.id).toBe(importJob.importJob.id);
    expect(reloadedImport.mappings.map((mapping) => mapping.field)).toEqual(expect.arrayContaining(["sku", "name", "base_price_minor"]));
    expect(reloadedImport.errors).toHaveLength(2);
    await client.dataJobs.cancelImport(importJob.importJob.id);
    expect((await client.dataJobs.getImport(importJob.importJob.id)).importJob.status).toBe("CANCELLED");

    const mappingPreview = await client.dataJobs.previewImport({
      model: "product.product",
      sourceFileName: `gateway-mapping-${timestamp}.csv`,
      sourceContentType: "text/csv",
      idempotencyKey: `gateway-mapping-${timestamp}`,
      columns: ["code", "title"],
      rows: [{ code: `MAP-${timestamp}`, title: "Mapped Query Product" }]
    });
    expect(mappingPreview.importJob.status).toBe("FAILED");
    const remapped = await client.dataJobs.updateImportMappings(mappingPreview.importJob.id, [
      { source: "code", field: "sku" },
      { source: "title", field: "name" }
    ]);
    expect(remapped.importJob.status).toBe("READY");
    const confirmedImport = await client.dataJobs.confirmImport(mappingPreview.importJob.id);
    let completedImport = confirmedImport.importJob;
    for (let attempt = 0; attempt < 40 && completedImport.status !== "COMPLETED" && completedImport.status !== "FAILED"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      completedImport = (await client.dataJobs.getImport(mappingPreview.importJob.id)).importJob;
    }
    expect(completedImport.status).toBe("COMPLETED");
    expect(completedImport.processed_rows).toBe(1);

    const exportJob = await client.dataJobs.export({
      query: {
        version: 1,
        model: "product.product",
        fields: ["sku", "name"],
        pagination: { limit: 10, offset: 0 }
      },
      selectedFields: ["sku", "name"],
      idempotencyKey: `export-${timestamp}`,
      format: "CSV"
    });
    let completedExport = exportJob.exportJob;
    for (let attempt = 0; attempt < 40 && completedExport.status !== "COMPLETED" && completedExport.status !== "FAILED"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      completedExport = (await client.dataJobs.getExport(exportJob.exportJob.id)).exportJob;
    }
    expect(completedExport.status).toBe("COMPLETED");
    expect(completedExport.content_type).toContain("text/csv");
    const exportedContent = await client.dataJobs.downloadExport(exportJob.exportJob.id);
    expect(exportedContent).toContain("SKU,Name");

    const replayedExport = await client.dataJobs.export({
      query: {
        version: 1,
        model: "product.product",
        fields: ["sku", "name"],
        pagination: { limit: 10, offset: 0 }
      },
      selectedFields: ["sku", "name"],
      idempotencyKey: `export-${timestamp}`,
      format: "CSV"
    });
    expect(replayedExport.exportJob.id).toBe(exportJob.exportJob.id);
    await expectGatewayStatus(() => client.dataJobs.export({
      query: {
        version: 1,
        model: "product.product",
        fields: ["sku", "name"],
        pagination: { limit: 10, offset: 0 }
      },
      selectedFields: ["name"],
      idempotencyKey: `export-${timestamp}`,
      format: "JSON"
    }), 409);

    const xlsxJob = await client.dataJobs.export({
      query: {
        version: 1,
        model: "product.product",
        fields: ["sku", "name"],
        pagination: { limit: 10, offset: 0 }
      },
      selectedFields: ["sku", "name"],
      idempotencyKey: `xlsx-${timestamp}`,
      format: "XLSX"
    });
    let completedXlsx = xlsxJob.exportJob;
    for (let attempt = 0; attempt < 40 && completedXlsx.status !== "COMPLETED" && completedXlsx.status !== "FAILED"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      completedXlsx = (await client.dataJobs.getExport(xlsxJob.exportJob.id)).exportJob;
    }
    expect(completedXlsx.status).toBe("COMPLETED");
    expect(completedXlsx.content_type).toContain("spreadsheetml.sheet");
    expect((await client.dataJobs.downloadExportFile(xlsxJob.exportJob.id)).size).toBeGreaterThan(0);

    const history = await client.query.listHistory({ model: "product.product", limit: 20 });
    expect(history.history.some((entry) => entry.model === "product.product" && entry.result_count >= 0)).toBe(true);

    const template = await client.query.saveExportTemplate({
      name: `Gateway Export ${timestamp}`,
      scope: "PRIVATE",
      query: {
        version: 1,
        model: "product.product",
        fields: ["sku", "name"],
        pagination: { limit: 10, offset: 0 }
      },
      selectedFields: ["sku", "name"]
    });
    expect(template.template.selected_fields).toEqual(["sku", "name"]);
    expect((await client.query.listExportTemplates("product.product")).templates.some((item) => item.id === template.template.id)).toBe(true);
    await client.query.archiveExportTemplate(template.template.id);
  }, 90_000);
});
