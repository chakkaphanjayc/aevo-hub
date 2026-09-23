import { randomUUID } from "node:crypto";
import type {
  CatalogSnapshot,
  CustomerStoreProfile,
  SessionPrincipal,
  StoreApplicationAccessSummary,
  StoreTemplateSummary,
  StoreSummary
} from "@aevo/contracts";
import type { Database } from "./client";
import { listCatalog } from "./catalog";
import { getCustomerStoreProfile } from "./customer-discovery";
import { throwDatabaseError } from "./errors";
import { getOrganizationStore } from "./organizations";
import { canAccessStore } from "./repository";
import { listStoreApplicationAccess } from "./store-application-access";

type Row = Record<string, unknown>;

export class StoreTemplateError extends Error {
  constructor(
    readonly code: "STORE_NOT_FOUND" | "STORE_TEMPLATE_NOT_FOUND" | "STORE_TEMPLATE_PRODUCT_MISSING" | "STORE_TEMPLATE_VARIANT_MISSING",
    message: string
  ) {
    super(message);
    this.name = "StoreTemplateError";
  }
}

interface TemplateSnapshot {
  version: 1;
  store: {
    timezone: string;
    currency: string;
    storeMode: StoreSummary["storeMode"];
    address: string | null;
    phone: string | null;
    taxId: string | null;
  };
  applications: Array<Pick<StoreApplicationAccessSummary, "applicationCode" | "status">>;
  profile: CustomerStoreProfile | null;
  availability: Array<{
    sku: string;
    channel: string;
    isAvailable: boolean;
    soldOut: boolean;
    priceOverrideMinor?: number;
  }>;
  menus: Array<{
    code: string;
    name: string;
    channel: string;
    status: string;
    items: Array<{
      sku: string;
      variantCode?: string;
      priceOverrideMinor?: number;
      sortOrder: number;
      isAvailable: boolean;
      soldOut: boolean;
    }>;
  }>;
}

function mapTemplate(row: Row): StoreTemplateSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    sourceStoreId: row.source_store_id ? String(row.source_store_id) : null,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function buildSnapshot(
  store: StoreSummary,
  applications: StoreApplicationAccessSummary[],
  profile: CustomerStoreProfile | null,
  catalog: CatalogSnapshot
): TemplateSnapshot {
  const productById = new Map(catalog.products.map((product) => [product.id, product]));
  return {
    version: 1,
    store: {
      timezone: store.timezone,
      currency: store.currency ?? "THB",
      storeMode: store.storeMode ?? "POS",
      address: store.address ?? null,
      phone: store.phone ?? null,
      taxId: store.taxId ?? null
    },
    applications: applications.map((application) => ({
      applicationCode: application.applicationCode,
      status: application.status
    })),
    profile,
    availability: catalog.products.flatMap((product) => product.availability.map((availability) => ({
      sku: product.sku,
      channel: availability.channel,
      isAvailable: availability.isAvailable,
      soldOut: availability.soldOut,
      ...(availability.priceOverrideMinor === undefined ? {} : { priceOverrideMinor: availability.priceOverrideMinor })
    }))),
    menus: catalog.menus.map((menu) => ({
      code: menu.code,
      name: menu.name,
      channel: menu.channel,
      status: menu.status,
      items: menu.items.flatMap((item) => {
        const product = productById.get(item.productId);
        if (!product) return [];
        const variant = item.variantId ? product.variants.find((candidate) => candidate.id === item.variantId) : undefined;
        return [{
          sku: product.sku,
          ...(variant ? { variantCode: variant.code } : {}),
          ...(item.priceOverrideMinor === undefined ? {} : { priceOverrideMinor: item.priceOverrideMinor }),
          sortOrder: item.sortOrder,
          isAvailable: item.isAvailable,
          soldOut: item.soldOut
        }];
      })
    }))
  };
}

async function readSourceSnapshot(
  database: Database,
  principal: SessionPrincipal,
  sourceStoreId: string
): Promise<TemplateSnapshot> {
  if (!await canAccessStore(database, principal, sourceStoreId)) {
    throw new StoreTemplateError("STORE_NOT_FOUND", "The source store is not available to this membership");
  }
  const [store, profile, applications, catalog] = await Promise.all([
    getOrganizationStore(database, principal.organizationId, sourceStoreId, principal),
    getCustomerStoreProfile(database, principal.organizationId, sourceStoreId),
    listStoreApplicationAccess(database, principal, sourceStoreId),
    listCatalog(database, principal, sourceStoreId)
  ]);
  if (!store || !applications) throw new StoreTemplateError("STORE_NOT_FOUND", "The source store was not found");
  return buildSnapshot(store, applications, profile, catalog);
}

export async function listStoreTemplates(
  database: Database,
  principal: SessionPrincipal
): Promise<StoreTemplateSummary[]> {
  const result = await database.client
    .from("store_templates")
    .select("id,organization_id,name,source_store_id,created_by,created_at,updated_at")
    .eq("organization_id", principal.organizationId)
    .order("created_at", { ascending: false });
  throwDatabaseError(result.error, "store template list");
  return ((result.data ?? []) as Row[]).map(mapTemplate);
}

export async function createStoreTemplate(
  database: Database,
  principal: SessionPrincipal,
  input: { name: string; sourceStoreId: string }
): Promise<StoreTemplateSummary> {
  const snapshot = await readSourceSnapshot(database, principal, input.sourceStoreId);
  const result = await database.client
    .from("store_templates")
    .insert({
      organization_id: principal.organizationId,
      name: input.name.trim(),
      source_store_id: input.sourceStoreId,
      created_by: principal.userId,
      snapshot
    })
    .select("id,organization_id,name,source_store_id,created_by,created_at,updated_at")
    .single();
  if (result.error) {
    if (result.error.code === "23505") throw new StoreTemplateError("STORE_TEMPLATE_NOT_FOUND", "A template with this name already exists");
    throwDatabaseError(result.error, "store template create");
  }
  return mapTemplate(result.data as Row);
}

export async function createStoreFromTemplate(
  database: Database,
  principal: SessionPrincipal,
  input: { templateId: string; name: string; code: string; publicSlug?: string }
): Promise<StoreSummary> {
  const result = await database.client.rpc("hub_create_store_from_template", {
    p_organization_id: principal.organizationId,
    p_template_id: input.templateId,
    p_name: input.name.trim(),
    p_code: input.code.trim().toUpperCase(),
    p_created_by: principal.userId,
    p_public_slug: input.publicSlug?.trim().toLowerCase() || null
  });
  if (result.error) {
    const message = result.error.message;
    if (/STORE_TEMPLATE_NOT_FOUND/i.test(message)) throw new StoreTemplateError("STORE_TEMPLATE_NOT_FOUND", "The store template was not found");
    if (/STORE_TEMPLATE_PRODUCT_MISSING/i.test(message)) throw new StoreTemplateError("STORE_TEMPLATE_PRODUCT_MISSING", "A product referenced by this template no longer exists");
    if (/STORE_TEMPLATE_VARIANT_MISSING/i.test(message)) throw new StoreTemplateError("STORE_TEMPLATE_VARIANT_MISSING", "A product variant referenced by this template no longer exists");
    throwDatabaseError(result.error, "store template instantiate");
  }
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as Row | undefined;
  if (!row?.id) throw new Error("Store template instantiation returned no store");
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    code: String(row.code),
    timezone: String(row.timezone),
    currency: String(row.currency ?? "THB"),
    storeMode: String(row.store_mode ?? "POS") as StoreSummary["storeMode"],
    address: row.address ? String(row.address) : null,
    phone: row.phone ? String(row.phone) : null,
    taxId: row.tax_id ? String(row.tax_id) : null,
    status: String(row.status ?? "ACTIVE") as StoreSummary["status"]
  };
}

export async function duplicateStore(
  database: Database,
  principal: SessionPrincipal,
  input: { sourceStoreId: string; name: string; code: string; publicSlug?: string }
): Promise<StoreSummary> {
  const temporaryTemplateName = `__duplicate_${randomUUID()}`;
  const template = await createStoreTemplate(database, principal, {
    name: temporaryTemplateName,
    sourceStoreId: input.sourceStoreId
  });
  try {
    return await createStoreFromTemplate(database, principal, {
      templateId: template.id,
      name: input.name,
      code: input.code,
      ...(input.publicSlug ? { publicSlug: input.publicSlug } : {})
    });
  } finally {
    const cleanup = await database.client
      .from("store_templates")
      .delete()
      .eq("organization_id", principal.organizationId)
      .eq("id", template.id);
    if (cleanup.error) throwDatabaseError(cleanup.error, "temporary store template cleanup");
  }
}

export async function deleteStoreTemplate(
  database: Database,
  principal: SessionPrincipal,
  templateId: string
): Promise<boolean> {
  const result = await database.client
    .from("store_templates")
    .delete()
    .eq("organization_id", principal.organizationId)
    .eq("id", templateId)
    .select("id")
    .maybeSingle();
  throwDatabaseError(result.error, "store template delete");
  return Boolean(result.data);
}
