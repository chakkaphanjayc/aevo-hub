function favoriteKey(kind, targetId, targetKey) {
  if (kind === "MENU") return String(targetKey || "");
  return `${String(kind).toLowerCase()}:${String(targetId || "")}`;
}

export function createFavoritesClient({ apiFetch, onChange } = {}) {
  let favorites = [];
  const pending = new Set();

  function notify() {
    onChange?.([...favorites]);
  }

  async function load() {
    const response = await apiFetch("/api/v1/hub/favorites");
    favorites = Array.isArray(response?.favorites) ? response.favorites : [];
    notify();
    return [...favorites];
  }

  function find(kind, targetId, targetKey) {
    const key = favoriteKey(kind, targetId, targetKey);
    return favorites.find((favorite) => favorite.targetKey === key) || null;
  }

  async function toggle({ kind, targetId, targetKey, position = 0 }) {
    const key = favoriteKey(kind, targetId, targetKey);
    if (!key || pending.has(key)) return find(kind, targetId, targetKey);
    pending.add(key);
    try {
      const existing = find(kind, targetId, targetKey);
      if (existing) {
        await apiFetch(`/api/v1/hub/favorites/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
        favorites = favorites.filter((favorite) => favorite.id !== existing.id);
      } else {
        const body = { kind, position };
        if (kind === "MENU") body.targetKey = targetKey;
        else body.targetId = targetId;
        const response = await apiFetch("/api/v1/hub/favorites", {
          method: "POST",
          body: JSON.stringify(body)
        });
        if (response?.favorite) favorites = [...favorites.filter((favorite) => favorite.id !== response.favorite.id && favorite.targetKey !== response.favorite.targetKey), response.favorite];
      }
      notify();
      return find(kind, targetId, targetKey);
    } finally {
      pending.delete(key);
    }
  }

  return {
    load,
    find,
    toggle,
    getAll: () => [...favorites]
  };
}
