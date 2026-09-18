const API_BASE = window.__AEVO_API_URL
  || (window.location.port === "4000"
    ? ""
    : (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:4000" : window.location.origin));
const CSRF_COOKIE_NAME = window.__AEVO_CSRF_COOKIE__ || "aevo_csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
let refreshPromise = null;
let currentUserPromise = null;

export class AuthApiError extends Error {
  constructor(message, status, code = "API_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "AuthApiError";
  }
}

function readCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!item) return null;
  try {
    return decodeURIComponent(item.slice(prefix.length));
  } catch {
    return null;
  }
}

function isAuthPath(path) {
  return path.includes("/api/auth/login") || path.includes("/api/auth/refresh") || path.includes("/api/auth/logout") || path.includes("/api/auth/password/");
}

async function refreshSession() {
  if (!refreshPromise) {
    const headers = new Headers({ accept: "application/json" });
    const csrf = readCookie(CSRF_COOKIE_NAME);
    if (csrf) headers.set("x-csrf-token", csrf);
    refreshPromise = fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers
    }).then((response) => response.ok).catch(() => false).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function apiFetch(path, options = {}, canRefresh = true) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

  const method = (options.method || "GET").toUpperCase();
  if (!SAFE_METHODS.has(method) && !headers.has("x-csrf-token")) {
    const csrf = readCookie(CSRF_COOKIE_NAME);
    if (csrf) headers.set("x-csrf-token", csrf);
  }

  let response = await fetch(`${API_BASE}${path}`, {
    ...options,
    method,
    credentials: "include",
    headers
  });

  if (response.status === 401 && canRefresh && !isAuthPath(path) && await refreshSession()) {
    const retryHeaders = new Headers(options.headers || {});
    retryHeaders.set("accept", "application/json");
    if (options.body !== undefined && !retryHeaders.has("content-type")) retryHeaders.set("content-type", "application/json");
    if (!SAFE_METHODS.has(method)) {
      const csrf = readCookie(CSRF_COOKIE_NAME);
      if (csrf) retryHeaders.set("x-csrf-token", csrf);
    }
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      method,
      credentials: "include",
      headers: retryHeaders
    });
  }

  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");
  if (!response.ok) {
    throw new AuthApiError(
      payload?.error?.message || payload?.message || `Request failed (${response.status})`,
      response.status,
      payload?.error?.code || "API_ERROR"
    );
  }
  return payload;
}

/**
 * Resolve the server-owned application session once per page. The browser
 * never reads the Supabase access token; the gateway validates the HttpOnly
 * session cookie and returns the effective user/principal projection.
 */
export async function getCurrentUser(force = false) {
  if (force) currentUserPromise = null;
  if (!currentUserPromise) {
    currentUserPromise = apiFetch("/api/auth/me")
      .catch((error) => {
        currentUserPromise = null;
        if (error instanceof AuthApiError && error.status === 401) return null;
        throw error;
      });
  }
  return currentUserPromise;
}

export async function redirectIfAuthenticated(nextPath = null) {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return false;

  const safeNext = typeof nextPath === "string" && nextPath.startsWith("/") && !nextPath.startsWith("//")
    ? nextPath
    : null;
  if (safeNext) {
    window.location.replace(safeNext);
    return true;
  }

  try {
    const organizations = await apiFetch("/api/v1/hub/organizations");
    const activeOrganization = organizations?.organizations?.[0];
    if (!activeOrganization) {
      window.location.replace("/organize?setup=true");
      return true;
    }
    const stores = await apiFetch(`/api/v1/hub/stores?organizationId=${encodeURIComponent(activeOrganization.id)}`, {
      headers: { "x-organization-id": activeOrganization.id }
    });
    window.location.replace(stores?.stores?.length ? "/workspace" : "/organize?setup=true");
  } catch {
    window.location.replace("/workspace");
  }
  return true;
}

export async function signOut() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" }, false);
  } finally {
    currentUserPromise = null;
    localStorage.removeItem("aevo.hub.orgId");
    localStorage.removeItem("aevo.hub.storeId");
  }
}

export async function exitImpersonation() {
  try {
    await apiFetch("/api/v1/admin/impersonate/exit", { method: "POST" }, false);
  } catch {
    // The redirect still returns the operator to a safe platform surface.
  }
  window.location.assign("/admin");
}

export async function setupImpersonationBanner() {
  const me = await getCurrentUser().catch(() => null);
  if (!me?.impersonation) return;

  const existing = document.getElementById("aevo-impersonation-banner");
  if (existing) return;

  const banner = document.createElement("div");
  banner.id = "aevo-impersonation-banner";
  banner.style.cssText = `
    position: sticky;
    top: 0;
    left: 0;
    right: 0;
    z-index: 99999;
    background: #78350f;
    color: #fef3c7;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 8px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 2px solid #f59e0b;
  `;
  banner.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px;">
      <span>⚠ IMPERSONATING TENANT SESSION</span>
      <span style="font-weight:400; opacity:0.85;">(Ephemeral session with strict 30-min TTL)</span>
    </div>
    <button type="button" id="btn-exit-impersonation" style="
      background: #f59e0b;
      color: #78350f;
      border: none;
      font-size: 0.75rem;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 9999px;
      cursor: pointer;
    ">Exit Impersonation ✕</button>
  `;

  document.body.prepend(banner);
  document.getElementById("btn-exit-impersonation")?.addEventListener("click", exitImpersonation);
}

if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    void setupImpersonationBanner();
  });
}

export { API_BASE };
