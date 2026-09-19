import type { NavigationFavorite, NavigationFavoriteKind } from "@aevo/contracts";
import { navigationFavoriteKinds } from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNavigationFavoriteKind(value: string): value is NavigationFavoriteKind {
  return navigationFavoriteKinds.includes(value as NavigationFavoriteKind);
}

function mapNavigationFavorite(row: Row): NavigationFavorite {
  const kind = String(row.kind);
  if (!isNavigationFavoriteKind(kind)) throw new Error("Supabase returned an invalid navigation favorite kind");
  return {
    id: String(row.id),
    userId: String(row.user_id),
    organizationId: row.organization_id ? String(row.organization_id) : null,
    storeId: row.store_id ? String(row.store_id) : null,
    kind,
    targetKey: String(row.target_key),
    label: String(row.label),
    href: String(row.href),
    iconKey: String(row.icon_key || "pin"),
    position: Number(row.position) || 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export interface UpsertNavigationFavoriteInput {
  userId: string;
  organizationId?: string | null;
  storeId?: string | null;
  kind: NavigationFavoriteKind;
  targetKey: string;
  label: string;
  href: string;
  iconKey: string;
  position?: number;
}

const favoriteColumns = "id,user_id,organization_id,store_id,kind,target_key,label,href,icon_key,position,created_at,updated_at";

export async function listNavigationFavorites(
  database: Database,
  userId: string,
  organizationIds?: readonly string[]
): Promise<NavigationFavorite[]> {
  const result = await database.client
    .from("user_navigation_favorites")
    .select(favoriteColumns)
    .eq("user_id", userId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (result.error) throwDatabaseError(result.error, "list navigation favorites");

  const allowedOrganizations = organizationIds ? new Set(organizationIds) : null;
  return (result.data ?? [])
    .filter(isRow)
    .filter((row) => row.organization_id == null || allowedOrganizations?.has(String(row.organization_id)) === true)
    .map(mapNavigationFavorite);
}

/**
 * Resolve a user's visible pins in one database read. The SQL read model
 * mirrors listAuthorizedStores' organization-wide versus store-scoped RBAC
 * rules. Returning null for a missing function keeps rolling deployments on
 * the safe, slower gateway-side validation path until the migration lands.
 */
export async function listAuthorizedNavigationFavorites(
  database: Database,
  userId: string
): Promise<NavigationFavorite[] | null> {
  const result = await database.client.rpc("hub_user_navigation_favorites", {
    p_user_id: userId
  });
  if (result.error) {
    if (["PGRST202", "42883"].includes(result.error.code ?? "")) return null;
    throwDatabaseError(result.error, "list authorized navigation favorites");
  }
  if (!Array.isArray(result.data)) {
    throw new Error("Authorized navigation favorites read model returned an invalid payload");
  }
  return result.data.filter(isRow).map(mapNavigationFavorite);
}

export async function upsertNavigationFavorite(
  database: Database,
  input: UpsertNavigationFavoriteInput
): Promise<NavigationFavorite> {
  const result = await database.client
    .from("user_navigation_favorites")
    .upsert({
      user_id: input.userId,
      organization_id: input.organizationId ?? null,
      store_id: input.storeId ?? null,
      kind: input.kind,
      target_key: input.targetKey,
      label: input.label.trim(),
      href: input.href,
      icon_key: input.iconKey,
      position: Math.max(0, Math.min(10000, Math.trunc(input.position ?? 0)))
    }, { onConflict: "user_id,target_key" })
    .select(favoriteColumns)
    .single();
  if (result.error) throwDatabaseError(result.error, "save navigation favorite");
  return mapNavigationFavorite(result.data as Row);
}

export async function deleteNavigationFavorite(
  database: Database,
  userId: string,
  favoriteId: string
): Promise<boolean> {
  const result = await database.client
    .from("user_navigation_favorites")
    .delete()
    .eq("id", favoriteId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (result.error) throwDatabaseError(result.error, "delete navigation favorite");
  return Boolean(result.data);
}
