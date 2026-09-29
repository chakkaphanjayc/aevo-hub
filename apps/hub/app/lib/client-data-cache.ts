import { ClientDataCache, createClientDataCache } from "@aevo/client-data-cache";

interface SyncManifest {
  resources?: Record<string, string>;
}

function resourceVersions(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const resources = (value as { resources?: unknown }).resources;
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) return {};
  return Object.fromEntries(
    Object.entries(resources).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function resourceVersionFingerprint(value: unknown): string {
  return Object.entries(resourceVersions(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, version]) => `${key}=${version}`)
    .join("|");
}

export function createHubClientDataCache(userId: string, organizationId?: string | null, storeId?: string | null): ClientDataCache {
  return createClientDataCache({
    namespace: {
      application: "HUB",
      userId,
      ...(organizationId !== undefined ? { organizationId } : {}),
      ...(storeId !== undefined ? { storeId } : {})
    },
    defaultTtlMs: 15_000,
    maxMemoryEntries: 128
  });
}

export async function syncHubManifest(cache: ClientDataCache): Promise<void> {
  const previous = await cache.getStale<SyncManifest>("sync/manifest");
  const current = await cache.getOrLoad<SyncManifest>("sync/manifest", async ({ etag }) => {
    const response = await fetch("/api/v1/sync/manifest", {
      credentials: "include",
      headers: etag ? { "if-none-match": etag } : { accept: "application/json" }
    });
    if (response.status === 304) return { status: "not-modified", ttlMs: 15_000 };
    if (response.status === 401 || response.status === 403) {
      await cache.clear();
      throw new Error(`Sync manifest authorization failed with status ${response.status}`);
    }
    if (!response.ok) throw new Error(`Sync manifest request failed with status ${response.status}`);
    const value = await response.json() as SyncManifest;
    return {
      status: "ok",
      value,
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      version: "1",
      ttlMs: 15_000
    };
  });
  const etagChanged = Boolean(previous?.etag && current.entry.etag && previous.etag !== current.entry.etag);
  const resourceVersionsChanged = previous
    ? resourceVersionFingerprint(previous.value) !== resourceVersionFingerprint(current.value)
    : false;
  if (previous && (etagChanged || resourceVersionsChanged)) {
    await cache.clearExcept(["sync/manifest"]);
  }
}
