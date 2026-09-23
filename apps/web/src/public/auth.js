const API_BASE = window.__AEVO_API_URL
  || (window.location.port === "4000"
    ? ""
    : (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:4000" : window.location.origin));
const CSRF_COOKIE_NAME = window.__AEVO_CSRF_COOKIE__ || "aevo_csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REQUEST_TIMEOUT_MS = 15000;
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

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const callerSignal = options.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  const timeoutId = window.setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), timeoutMs);

  if (callerSignal) {
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

async function refreshSession() {
  if (!refreshPromise) {
    const headers = new Headers({ accept: "application/json" });
    const csrf = readCookie(CSRF_COOKIE_NAME);
    if (csrf) headers.set("x-csrf-token", csrf);
    refreshPromise = fetchWithTimeout(`${API_BASE}/api/auth/refresh`, {
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

  let response = await fetchWithTimeout(`${API_BASE}${path}`, {
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
    response = await fetchWithTimeout(`${API_BASE}${path}`, {
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

export function getDefaultAuthenticatedPath(bootstrap) {
  const organizations = Array.isArray(bootstrap?.organizations) ? bootstrap.organizations : [];
  if (organizations.length === 0) return "/setup";

  const role = String(bootstrap?.principal?.role || "");
  const hasOrganizationLayerAccess = organizations.some((organization) => ["OWNER", "ADMIN", "ORGANIZATION_MANAGER"].includes(String(organization?.role || "")));
  if (hasOrganizationLayerAccess || ["OWNER", "ADMIN", "ORGANIZATION_MANAGER"].includes(role)) return "/organize";

  const stores = Array.isArray(bootstrap?.stores) ? bootstrap.stores : [];
  if (stores.length > 0) return `/workspace?storeId=${encodeURIComponent(stores[0].id)}`;
  const organizationId = organizations[0]?.id;
  return organizationId ? `/setup?organizationId=${encodeURIComponent(organizationId)}` : "/setup";
}

export async function redirectIfAuthenticated(nextPath = null) {
  const safeNext = typeof nextPath === "string" && nextPath.startsWith("/") && !nextPath.startsWith("//")
    ? nextPath
    : null;
  if (safeNext) {
    const me = await getCurrentUser().catch(() => null);
    if (!me) return false;
    window.location.replace(safeNext);
    return true;
  }

  try {
    const bootstrap = await apiFetch("/api/v1/hub/bootstrap");
    window.location.replace(getDefaultAuthenticatedPath(bootstrap));
  } catch (error) {
    if (error instanceof AuthApiError && error.status === 401) return false;
    window.location.replace("/setup");
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
      <svg class="icon" aria-hidden="true" viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M12 3 3.5 19h17L12 3Z"/><path d="M12 9v4M12 17h.01"/></svg>
      <span>Impersonating tenant session</span>
      <span style="font-weight:400; opacity:0.85;">(Ephemeral session with strict 30-minute TTL)</span>
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
    ">Exit impersonation</button>
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
