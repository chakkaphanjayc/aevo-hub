/**
 * Legacy test-only cache kept for compatibility with the old navigation
 * contract. Protected route loaders must not use it: it has no tenant/user
 * namespace, persistence boundary, or authorization invalidation semantics.
 * Use @aevocado/client-data-cache only for non-sensitive read models.
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const clientCache = new Map<string, CacheEntry<unknown>>();

function isClientContext(): boolean {
  return typeof window !== "undefined" || process.env.NODE_ENV === "test";
}

/**
 * Retrieve cached client loader data if it exists and has not expired.
 */
export function getClientCachedData<T>(key: string, ttlMs = 30_000): T | undefined {
  if (!isClientContext()) return undefined;
  const entry = clientCache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > ttlMs) {
    clientCache.delete(key);
    return undefined;
  }
  return entry.data;
}

/**
 * Store data into the client in-memory cache for instant client-side route transitions.
 */
export function setClientCachedData<T>(key: string, data: T): void {
  if (!isClientContext()) return;
  clientCache.set(key, { data, timestamp: Date.now() });
}

/**
 * Invalidate client cache entries (e.g. after mutations or explicit refresh).
 */
export function invalidateClientCache(prefix?: string): void {
  if (!isClientContext()) return;
  if (!prefix) {
    clientCache.clear();
    return;
  }
  for (const key of clientCache.keys()) {
    if (key.includes(prefix)) {
      clientCache.delete(key);
    }
  }
}
