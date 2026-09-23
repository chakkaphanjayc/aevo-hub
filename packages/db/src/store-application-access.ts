import {
  storeApplicationCodes,
  type SessionPrincipal,
  type StoreApplicationAccessSummary,
  type StoreApplicationCode,
  type StoreApplicationStatus
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";
import { canAccessStore } from "./repository";

type Row = Record<string, unknown>;

interface RegistryRow {
  code: string;
  name: string;
  status: "ACTIVE" | "DISABLED";
}

export class StoreApplicationAccessError extends Error {
  constructor(
    readonly code: "INVALID_APPLICATION" | "APPLICATION_DISABLED",
    message: string
  ) {
    super(message);
    this.name = "StoreApplicationAccessError";
  }
}

export function isStoreApplicationCode(value: string): value is StoreApplicationCode {
  return storeApplicationCodes.includes(value as StoreApplicationCode);
}

function status(value: unknown): StoreApplicationStatus {
  return String(value) === "ACTIVE" ? "ACTIVE" : "DISABLED";
}

function mapRegistry(row: Row): RegistryRow {
  return {
    code: String(row.code),
    name: String(row.name),
    status: String(row.status) === "ACTIVE" ? "ACTIVE" : "DISABLED"
  };
}

async function loadRegistry(database: Database): Promise<Map<string, RegistryRow>> {
  const result = await database.client
    .from("application_registry")
    .select("code,name,status")
    .in("code", [...storeApplicationCodes]);
  throwDatabaseError(result.error, "store application registry lookup");
  return new Map((result.data ?? []).map((row) => {
    const mapped = mapRegistry(row as Row);
    return [mapped.code, mapped] as const;
  }));
}

export async function listStoreApplicationAccess(
  database: Database,
  principal: SessionPrincipal,
  storeId: string
): Promise<StoreApplicationAccessSummary[] | null> {
  if (!await canAccessStore(database, principal, storeId)) return null;

  const [registry, accessResult] = await Promise.all([
    loadRegistry(database),
    database.client
      .from("store_application_access")
      .select("organization_id,store_id,application_code,status")
      .eq("organization_id", principal.organizationId)
      .eq("store_id", storeId)
  ]);
  throwDatabaseError(accessResult.error, "store application access list");

  const configured = new Map(
    (accessResult.data ?? []).map((row) => [
      String((row as Row).application_code),
      status((row as Row).status)
    ])
  );

  return storeApplicationCodes.flatMap((applicationCode) => {
    const app = registry.get(applicationCode);
    if (!app) return [];
    return [{
      organizationId: principal.organizationId,
      storeId,
      applicationCode,
      applicationName: app.name,
      status: configured.get(applicationCode) ?? "DISABLED",
      applicationActive: app.status === "ACTIVE"
    } satisfies StoreApplicationAccessSummary];
  });
}

export async function isStoreApplicationEnabled(
  database: Database,
  principal: SessionPrincipal,
  storeId: string,
  applicationCode: string
): Promise<boolean> {
  if (!isStoreApplicationCode(applicationCode)) return true;
  if (!await canAccessStore(database, principal, storeId)) return false;

  const result = await database.client
    .from("store_application_access")
    .select("status")
    .eq("organization_id", principal.organizationId)
    .eq("store_id", storeId)
    .eq("application_code", applicationCode)
    .maybeSingle();
  throwDatabaseError(result.error, "store application access check");
  return status((result.data as Row | null)?.status) === "ACTIVE";
}

export async function updateStoreApplicationAccess(
  database: Database,
  principal: SessionPrincipal,
  storeId: string,
  applicationCode: string,
  enabled: boolean
): Promise<StoreApplicationAccessSummary | null> {
  if (!isStoreApplicationCode(applicationCode)) {
    throw new StoreApplicationAccessError(
      "INVALID_APPLICATION",
      "Only store-operational applications can be configured here"
    );
  }
  if (!await canAccessStore(database, principal, storeId)) return null;

  const registry = await loadRegistry(database);
  const app = registry.get(applicationCode);
  if (!app || app.status !== "ACTIVE") {
    throw new StoreApplicationAccessError(
      "APPLICATION_DISABLED",
      "This application is not active in the application registry"
    );
  }

  const result = await database.client
    .from("store_application_access")
    .upsert({
      organization_id: principal.organizationId,
      store_id: storeId,
      application_code: applicationCode,
      status: enabled ? "ACTIVE" : "DISABLED",
      updated_by: principal.userId,
      updated_at: new Date().toISOString()
    }, { onConflict: "organization_id,store_id,application_code" })
    .select("organization_id,store_id,application_code,status")
    .single();
  throwDatabaseError(result.error, "store application access update");

  const row = result.data as Row;
  return {
    organizationId: String(row.organization_id),
    storeId: String(row.store_id),
    applicationCode: applicationCode as StoreApplicationCode,
    applicationName: app.name,
    status: status(row.status),
    applicationActive: true
  };
}
