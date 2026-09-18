import type {
  AppCatalogItem,
  AppEntitlement,
  AppSubscriptionSummary,
  BookableResourceSummary,
  BookingSummary,
  BookingWaitlistSummary,
  CashMovementSummary,
  CashSessionSummary,
  CreateOrderInput,
  DailyClosingSummary,
  DeviceSummary,
  MemberSummary,
  OrderListItem,
  OrderSummary,
  OrganizationSummary,
  PreparationStationSummary,
  PreparationTaskSummary,
  QueueDisplaySnapshot,
  QueueTicketSummary,
  Role,
  SessionPrincipal,
  StoreSummary,
  VenueSummary,
  OnboardingStep,
  OnboardingSessionSummary,
  SetupChecklistSummary,
  DemoDataSummary,
  EntitlementResult,
  QueryModelMetadata,
  QuerySpecV1,
  QueryGroupResult,
  QueryHistoryRecord,
  ExportTemplateRecord,
  SavedQueryRecord,
  SavedQueryScope,
  QueryImportJobSummary,
  QueryImportMappingRecord,
  QueryImportErrorRecord,
  QueryExportJobSummary
} from "@aevo/contracts";

const ORGANIZATION_STORAGE_KEY = "aevo.hub.orgId";
const STORE_STORAGE_KEY = "aevo.hub.storeId";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayClientConfig {
  baseUrl?: string;
  organizationId?: string;
  storeId?: string;
  deviceToken?: string;
  /** Supabase access token for trusted non-browser ecosystem clients. */
  accessToken?: string;
  /** Raw browser-session cookie header for server-side clients. */
  sessionCookie?: string;
  /** CSRF token paired with sessionCookie for mutating requests. */
  csrfToken?: string;
}

export class GatewayClient {
  private baseUrl: string;
  private organizationId?: string;
  private storeId?: string;
  private deviceToken?: string;
  private accessToken?: string;
  private csrfToken?: string;
  private readonly cookies = new Map<string, string>();

  constructor(config: GatewayClientConfig = {}) {
    const configuredApi = typeof import.meta !== "undefined" && import.meta.env?.PUBLIC_API_URL
      ? String(import.meta.env.PUBLIC_API_URL)
      : "";
    this.baseUrl = (config.baseUrl ?? configuredApi).replace(/\/$/, "");
    this.organizationId = config.organizationId;
    this.storeId = config.storeId;
    this.deviceToken = config.deviceToken;
    this.accessToken = config.accessToken;
    this.csrfToken = config.csrfToken;
    if (config.sessionCookie) this.importCookieHeader(config.sessionCookie);
  }

  setAccessToken(accessToken: string | undefined): void {
    this.accessToken = accessToken;
  }

  setSession(session: { cookie?: string; csrfToken?: string } | undefined): void {
    this.cookies.clear();
    this.csrfToken = session?.csrfToken;
    if (session?.cookie) this.importCookieHeader(session.cookie);
  }

  setOrganizationId(orgId: string | undefined): void {
    this.organizationId = orgId;
    if (typeof window !== "undefined") {
      if (orgId) localStorage.setItem(ORGANIZATION_STORAGE_KEY, orgId);
      else localStorage.removeItem(ORGANIZATION_STORAGE_KEY);
    }
  }

  setStoreId(storeId: string | undefined): void {
    this.storeId = storeId;
    if (typeof window !== "undefined") {
      if (storeId) localStorage.setItem(STORE_STORAGE_KEY, storeId);
      else localStorage.removeItem(STORE_STORAGE_KEY);
    }
  }

  setDeviceToken(token: string | undefined): void {
    this.deviceToken = token;
  }

  getOrganizationId(): string | undefined {
    if (this.organizationId) return this.organizationId;
    if (typeof window !== "undefined") {
      return localStorage.getItem(ORGANIZATION_STORAGE_KEY) || undefined;
    }
    return undefined;
  }

  getStoreId(): string | undefined {
    if (this.storeId) return this.storeId;
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORE_STORAGE_KEY) || undefined;
    }
    return undefined;
  }

  getDeviceToken(): string | undefined {
    if (this.deviceToken) return this.deviceToken;
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem("aevo.device.session.v1");
        if (!raw) return undefined;
        const session = JSON.parse(raw) as { deviceToken?: string };
        return session.deviceToken;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private importCookieHeader(cookieHeader: string): void {
    for (const part of cookieHeader.split(";")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name && value) this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string | undefined {
    if (!this.cookies.size) return undefined;
    return Array.from(this.cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private csrfHeader(): string | undefined {
    if (this.csrfToken) return this.csrfToken;
    const csrfCookie = Array.from(this.cookies.entries()).find(([name]) => name.toLowerCase().includes("csrf"));
    if (!csrfCookie) return undefined;
    try {
      return decodeURIComponent(csrfCookie[1]);
    } catch {
      return csrfCookie[1];
    }
  }

  private captureCookies(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") || "").split(/,(?=\s*[^;,=\s]+=[^;,]*)/).filter(Boolean);

    for (const setCookie of setCookies) {
      const pair = setCookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) continue;
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (name.toLowerCase().includes("csrf")) {
        try {
          this.csrfToken = decodeURIComponent(value);
        } catch {
          this.csrfToken = value;
        }
      }
    }
  }

  private requestHeaders(options: RequestInit, method: string): Headers {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");

    const orgId = this.getOrganizationId();
    if (orgId && !headers.has("x-organization-id")) headers.set("x-organization-id", orgId);

    const storeId = this.getStoreId();
    if (storeId && !headers.has("x-store-id")) headers.set("x-store-id", storeId);

    const deviceToken = this.getDeviceToken();
    if (deviceToken && !headers.has("x-device-token")) headers.set("x-device-token", deviceToken);

    if (this.accessToken && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }

    if (typeof window === "undefined") {
      const cookieHeader = this.cookieHeader();
      if (cookieHeader && !headers.has("cookie")) headers.set("cookie", cookieHeader);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("x-csrf-token")) {
      const csrf = this.csrfHeader();
      if (csrf) headers.set("x-csrf-token", csrf);
    }

    if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return headers;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = (options.method || "GET").toUpperCase();
    let response: Response;

    try {
      response = await fetch(url, {
        ...options,
        credentials: "include",
        method,
        headers: this.requestHeaders(options, method)
      });
      this.captureCookies(response);

      if (response.status === 401 && this.cookies.size > 0 && !path.includes("/auth/login") && !path.includes("/auth/refresh")) {
        const refreshRes = await fetch(`${this.baseUrl}/api/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: this.requestHeaders({ method: "POST" }, "POST")
        });
        this.captureCookies(refreshRes);
        if (refreshRes.ok) {
          response = await fetch(url, {
            ...options,
            credentials: "include",
            method,
            headers: this.requestHeaders(options, method)
          });
          this.captureCookies(response);
        }
      }
    } catch {
      throw new GatewayError("ไม่สามารถเชื่อมต่อ Aevo Gateway ได้ กรุณาลองใหม่อีกครั้ง", 0, "GATEWAY_NETWORK_ERROR");
    }

    if (!response.ok) {
      const errorJson = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: unknown };
      } | null;
      throw new GatewayError(
        errorJson?.error?.message ?? `Gateway request failed with status ${response.status}`,
        response.status,
        errorJson?.error?.code ?? "GATEWAY_ERROR",
        errorJson?.error?.details
      );
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      return response.json() as Promise<T>;
    }
    return response.text() as Promise<T>;
  }

  async requestBinary(path: string, options: RequestInit = {}): Promise<Blob> {
    const url = `${this.baseUrl}${path}`;
    const method = (options.method || "GET").toUpperCase();
    let response = await fetch(url, {
      ...options,
      credentials: "include",
      method,
      headers: this.requestHeaders(options, method)
    });
    this.captureCookies(response);
    if (response.status === 401 && this.cookies.size > 0 && !path.includes("/auth/login") && !path.includes("/auth/refresh")) {
      const refreshRes = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: this.requestHeaders({ method: "POST" }, "POST")
      });
      this.captureCookies(refreshRes);
      if (refreshRes.ok) {
        response = await fetch(url, {
          ...options,
          credentials: "include",
          method,
          headers: this.requestHeaders(options, method)
        });
        this.captureCookies(response);
      }
    }
    if (!response.ok) {
      const errorJson = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
      throw new GatewayError(errorJson?.error?.message ?? `Gateway request failed with status ${response.status}`, response.status, errorJson?.error?.code ?? "GATEWAY_ERROR", errorJson?.error?.details);
    }
    return response.blob();
  }

  readonly auth = {
    login: (input: { email: string; password: string }): Promise<{
      success: boolean;
      session: { expiresAt: string };
      user: { id: string; email: string; displayName?: string; role?: string | null } | null;
    }> => this.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input)
    }),

    me: (): Promise<{
      user: { id: string; email: string; displayName?: string };
      principal: SessionPrincipal | null;
    }> => this.request("/api/auth/me"),

    logout: (): Promise<void> => this.request("/api/auth/logout", { method: "POST" }),

    listSessions: (): Promise<{ sessions: Array<{
      id: string;
      userAgent?: string;
      ipAddress?: string;
      createdAt: string;
      lastSeenAt: string;
      accessExpiresAt: string;
      idleExpiresAt: string;
      absoluteExpiresAt: string;
      revokedAt?: string;
      current: boolean;
    }> }> => this.request("/api/auth/sessions")
  };

  // ==========================================
  // SURFACE 1: Aevo Hub Management API Client
  // ==========================================
  readonly hub = {
    getMe: (): Promise<{ principal: SessionPrincipal }> =>
      this.request<{ principal: SessionPrincipal }>("/api/v1/hub/me"),

    getOrganizations: (): Promise<{ organizations: OrganizationSummary[] }> =>
      this.request<{ organizations: OrganizationSummary[] }>("/api/v1/hub/organizations"),

    createOrganization: (input: { name: string; slug?: string }): Promise<{ organization: OrganizationSummary }> =>
      this.request<{ organization: OrganizationSummary }>("/api/v1/hub/organizations", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    getStores: (organizationId?: string): Promise<{ stores: StoreSummary[] }> => {
      const q = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
      return this.request<{ stores: StoreSummary[] }>(`/api/v1/hub/stores${q}`);
    },

    createStore: (input: {
      organizationId?: string;
      name: string;
      code: string;
      timezone?: string;
    }): Promise<{ store: StoreSummary }> =>
      this.request<{ store: StoreSummary }>("/api/v1/hub/stores", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    getApps: (): Promise<{ apps: AppCatalogItem[] }> =>
      this.request<{ apps: AppCatalogItem[] }>("/api/v1/hub/apps"),

    listApps: (): Promise<AppCatalogItem[]> =>
      this.request<{ apps: AppCatalogItem[] }>("/api/v1/hub/apps").then((res) => res.apps),

    listOrganizations: (): Promise<OrganizationSummary[]> =>
      this.request<{ organizations: OrganizationSummary[] }>("/api/v1/hub/organizations").then((res) => res.organizations),

    listStores: (organizationId?: string): Promise<StoreSummary[]> => {
      const q = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
      return this.request<{ stores: StoreSummary[] }>(`/api/v1/hub/stores${q}`).then((res) => res.stores);
    },

    getSubscriptions: (storeId?: string): Promise<{ subscriptions: AppSubscriptionSummary[] }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request<{ subscriptions: AppSubscriptionSummary[] }>(`/api/v1/hub/subscriptions${q}`);
    },

    getEntitlement: (appId: string, storeId?: string): Promise<{ entitlement: AppEntitlement }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request<{ entitlement: AppEntitlement }>(`/api/v1/hub/entitlements/${encodeURIComponent(appId)}${q}`);
    },

    getMembers: (): Promise<{ members: MemberSummary[] }> =>
      this.request<{ members: MemberSummary[] }>("/api/v1/hub/members"),

    updateMember: (
      membershipId: string,
      input: { role?: Role; customPermissions?: string[] }
    ): Promise<{ member: MemberSummary }> =>
      this.request<{ member: MemberSummary }>(`/api/v1/hub/members/${encodeURIComponent(membershipId)}`, {
        method: "PATCH",
        body: JSON.stringify(input)
      }),

    getAuditLogs: (query: { limit?: number; action?: string; resourceType?: string } = {}): Promise<{ logs: any[] }> => {
      const params = new URLSearchParams();
      if (query.limit) params.set("limit", String(query.limit));
      if (query.action) params.set("action", query.action);
      if (query.resourceType) params.set("resourceType", query.resourceType);
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request<{ logs: any[] }>(`/api/v1/hub/audit-logs${q}`);
    },

    getStats: (): Promise<{ stats: { totalApps: number; activeApps: number; totalStores: number; totalMembers: number } }> =>
      this.request<{ stats: { totalApps: number; activeApps: number; totalStores: number; totalMembers: number } }>("/api/v1/hub/stats"),

    getBillingPortal: (returnUrl?: string): Promise<{ url: string }> =>
      this.request<{ url: string }>("/api/v1/hub/billing/portal", {
        method: "POST",
        body: JSON.stringify({ ...(returnUrl ? { returnUrl } : {}) })
      }),

    updateStore: (
      storeId: string,
      input: { name?: string; code?: string; timezone?: string; currency?: string; status?: "ACTIVE" | "INACTIVE" }
    ): Promise<{ store: StoreSummary }> =>
      this.request<{ store: StoreSummary }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}`, {
        method: "PATCH",
        body: JSON.stringify(input)
      }),

    deleteStore: (storeId: string): Promise<{ success: boolean }> =>
      this.request<{ success: boolean }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}`, {
        method: "DELETE"
      }),

    addMember: (input: {
      email: string;
      displayName?: string;
      role: Role;
      storeIds?: string[];
    }): Promise<{ member: MemberSummary }> =>
      this.request<{ member: MemberSummary }>("/api/v1/hub/members", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    deleteMember: (membershipId: string): Promise<{ success: boolean }> =>
      this.request<{ success: boolean }>(`/api/v1/hub/members/${encodeURIComponent(membershipId)}`, {
        method: "DELETE"
      }),

    getDevices: (storeId?: string): Promise<{ devices: DeviceSummary[] }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request<{ devices: DeviceSummary[] }>(`/api/v1/hub/devices${q}`);
    },

    createDevicePairing: (input: {
      storeId: string;
      name: string;
      mode: string;
    }): Promise<{ device: DeviceSummary; pairingCode: string; pairingExpiresAt: string }> =>
      this.request("/api/v1/hub/devices", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    revokeDevice: (deviceId: string): Promise<{ success: boolean }> =>
      this.request<{ success: boolean }>(`/api/v1/hub/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: "POST"
      }),

    getOperatingMode: (): Promise<{
      mode: "testing" | "production";
      isUnlimitedTesting: boolean;
      description: string;
    }> =>
      this.request("/api/v1/hub/operating-mode"),

    onboarding: {
      register: (input: { email: string; password: string; fullName: string }): Promise<{
        success: boolean;
        user: { id: string; email: string; displayName: string };
        session: OnboardingSessionSummary;
      }> =>
        this.request("/api/v1/hub/onboarding/register", {
          method: "POST",
          body: JSON.stringify(input)
        }),

      getSession: (query?: { organizationId?: string }): Promise<{
        success: boolean;
        session: OnboardingSessionSummary;
      }> => {
        const params = new URLSearchParams();
        if (query?.organizationId) params.set("organizationId", query.organizationId);
        const q = params.toString() ? `?${params.toString()}` : "";
        return this.request(`/api/v1/hub/onboarding/session${q}`);
      },

      setObjectives: (input: { sessionId: string; objectives: string[] }): Promise<{
        success: boolean;
        session: OnboardingSessionSummary;
      }> =>
        this.request("/api/v1/hub/onboarding/objectives", {
          method: "POST",
          body: JSON.stringify(input)
        }),

      setupOrganization: (input: {
        sessionId: string;
        name: string;
        legalName?: string;
        businessType?: string;
        country?: string;
        timezone?: string;
        currency?: string;
        logoUrl?: string;
        contactEmail?: string;
        contactPhone?: string;
      }): Promise<{ success: boolean; organizationId: string; session: OnboardingSessionSummary }> =>
        this.request("/api/v1/hub/onboarding/organization", {
          method: "POST",
          body: JSON.stringify(input)
        }),

      setupStore: (input: {
        sessionId: string;
        organizationId: string;
        name: string;
        code: string;
        storeMode?: "POS" | "KIOSK" | "BOOKING" | "POS_BOOKING" | "CUSTOM";
        address?: string;
        phone?: string;
        taxId?: string;
      }): Promise<{ success: boolean; storeId: string; session: OnboardingSessionSummary }> =>
        this.request("/api/v1/hub/onboarding/store", {
          method: "POST",
          body: JSON.stringify(input)
        }),

      setupApps: (input: {
        sessionId: string;
        organizationId: string;
        appIds: string[];
      }): Promise<{ success: boolean; session: OnboardingSessionSummary }> =>
        this.request("/api/v1/hub/onboarding/apps", {
          method: "POST",
          body: JSON.stringify(input)
        }),

      setupBooking: (input: {
        sessionId: string;
        organizationId: string;
        storeId?: string;
        venueName: string;
        businessType: string;
        resourceNames: string[];
        durationMinutes: number;
        priceMinor: number;
        enableWaitlist: boolean;
      }): Promise<{ success: boolean; venueId: string; session: OnboardingSessionSummary }> =>
        this.request("/api/v1/hub/onboarding/booking-setup", {
          method: "POST",
          body: JSON.stringify(input)
        }),

      generateDemoData: (input: {
        organizationId: string;
        storeId: string;
        businessType?: string;
      }): Promise<{ success: boolean; demoData: DemoDataSummary }> =>
        this.request("/api/v1/hub/onboarding/demo-data", {
          method: "POST",
          body: JSON.stringify(input)
        }),

      markProgress: (input: {
        sessionId: string;
        organizationId: string;
        step: Extract<OnboardingStep, "RESOURCES" | "STAFF">;
      }): Promise<{ success: boolean; session: OnboardingSessionSummary }> =>
        this.request("/api/v1/hub/onboarding/progress", {
          method: "POST",
          body: JSON.stringify(input)
        }),

      clearDemoData: (
        organizationId: string,
        storeId?: string
      ): Promise<{ success: boolean; deletedCounts: Record<string, number> }> => {
        const params = new URLSearchParams({ organizationId, ...(storeId ? { storeId } : {}) });
        return this.request(`/api/v1/hub/onboarding/demo-data?${params.toString()}`, {
          method: "DELETE"
        });
      },

      getChecklist: (
        organizationId: string,
        storeId?: string
      ): Promise<{ success: boolean; checklist: SetupChecklistSummary }> => {
        const params = new URLSearchParams({ organizationId, ...(storeId ? { storeId } : {}) });
        return this.request(`/api/v1/hub/onboarding/checklist?${params.toString()}`);
      },

      complete: (sessionId: string): Promise<{ success: boolean; session: OnboardingSessionSummary }> =>
        this.request("/api/v1/hub/onboarding/complete", {
          method: "POST",
          body: JSON.stringify({ sessionId })
        })
    }
  };

  readonly query = {
    listModels: (): Promise<{ models: QueryModelMetadata[] }> =>
      this.request("/api/v1/query/models"),

    execute: (input: { query: QuerySpecV1; searchText?: string; storeId?: string }): Promise<{
      model: string;
      query: QuerySpecV1;
      rows: Array<Record<string, unknown>>;
      total: number;
      groups: QueryGroupResult[];
      aggregates: Record<string, number | null>;
    }> => this.request("/api/v1/query/execute", {
      method: "POST",
      body: JSON.stringify(input)
    }),

    parse: (searchText: string): Promise<{ where: QuerySpecV1["where"] }> => this.request("/api/v1/query/parse", {
      method: "POST",
      body: JSON.stringify({ searchText })
    }),

    listSaved: (model?: string): Promise<{ savedQueries: SavedQueryRecord[] }> => {
      const query = model ? `?model=${encodeURIComponent(model)}` : "";
      return this.request(`/api/v1/query/saved${query}`);
    },

    save: (input: {
      name: string;
      scope: SavedQueryScope;
      storeId?: string;
      query: QuerySpecV1;
    }): Promise<{ savedQuery: SavedQueryRecord }> => this.request("/api/v1/query/saved", {
      method: "POST",
      body: JSON.stringify(input)
    }),

    archive: (id: string): Promise<{ success: boolean }> => this.request(`/api/v1/query/saved/${encodeURIComponent(id)}/archive`, {
      method: "POST"
    }),

    listHistory: (input: { model?: string; limit?: number } = {}): Promise<{ history: QueryHistoryRecord[] }> => {
      const params = new URLSearchParams();
      if (input.model) params.set("model", input.model);
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      const query = params.toString() ? `?${params.toString()}` : "";
      return this.request(`/api/v1/query/history${query}`);
    },

    listExportTemplates: (model?: string): Promise<{ templates: ExportTemplateRecord[] }> => {
      const query = model ? `?model=${encodeURIComponent(model)}` : "";
      return this.request(`/api/v1/query/export-templates${query}`);
    },

    saveExportTemplate: (input: {
      name: string;
      scope: SavedQueryScope;
      storeId?: string;
      query: QuerySpecV1;
      selectedFields?: string[];
    }): Promise<{ template: ExportTemplateRecord }> => this.request("/api/v1/query/export-templates", {
      method: "POST",
      body: JSON.stringify(input)
    }),

    archiveExportTemplate: (id: string): Promise<{ success: boolean }> => this.request(`/api/v1/query/export-templates/${encodeURIComponent(id)}/archive`, {
      method: "POST"
    })
  };

  readonly dataJobs = {
    listImports: (): Promise<{ imports: QueryImportJobSummary[] }> => this.request("/api/v1/query/imports"),

    previewImport: (input: {
      model: string;
      sourceFileName: string;
      sourceContentType?: string;
      idempotencyKey: string;
      columns: string[];
      rows: Array<Record<string, unknown>>;
      mappings?: Array<{ source: string; field: string }>;
      storeId?: string;
    }): Promise<{ importJob: QueryImportJobSummary }> => this.request("/api/v1/query/imports", {
      method: "POST",
      body: JSON.stringify(input)
    }),

    getImport: (id: string): Promise<{ importJob: QueryImportJobSummary; mappings: QueryImportMappingRecord[]; errors: QueryImportErrorRecord[] }> => this.request(`/api/v1/query/imports/${encodeURIComponent(id)}`),

    updateImportMappings: (id: string, mappings: Array<{ source: string; field: string }>): Promise<{ importJob: QueryImportJobSummary; mappings: QueryImportMappingRecord[]; errors: QueryImportErrorRecord[] }> => this.request(`/api/v1/query/imports/${encodeURIComponent(id)}/mappings`, {
      method: "PATCH",
      body: JSON.stringify({ mappings })
    }),

    downloadImportErrors: (id: string): Promise<string> => this.request(`/api/v1/query/imports/${encodeURIComponent(id)}/errors/download`),

    confirmImport: (id: string): Promise<{ importJob: QueryImportJobSummary }> => this.request(`/api/v1/query/imports/${encodeURIComponent(id)}/confirm`, {
      method: "POST"
    }),

    cancelImport: (id: string): Promise<{ success: boolean }> => this.request(`/api/v1/query/imports/${encodeURIComponent(id)}/cancel`, {
      method: "POST"
    }),

    listExports: (): Promise<{ exports: QueryExportJobSummary[] }> => this.request("/api/v1/query/exports"),

    export: (input: {
      query: QuerySpecV1;
      selectedFields?: string[];
      format: "CSV" | "JSON" | "XLSX";
      idempotencyKey: string;
      storeId?: string;
    }): Promise<{ exportJob: QueryExportJobSummary }> => this.request("/api/v1/query/exports", {
      method: "POST",
      body: JSON.stringify(input)
    }),

    getExport: (id: string): Promise<{ exportJob: QueryExportJobSummary }> => this.request(`/api/v1/query/exports/${encodeURIComponent(id)}`),

    downloadExport: (id: string): Promise<string> => this.request(`/api/v1/query/exports/${encodeURIComponent(id)}/download`),
    downloadExportFile: (id: string): Promise<Blob> => this.requestBinary(`/api/v1/query/exports/${encodeURIComponent(id)}/download`)
  };

  // ==========================================
  // SURFACE 2: Staff & POS Operations Client
  // ==========================================
  readonly staff = {
    getContext: (storeId?: string): Promise<{
      principal: SessionPrincipal;
      stores: StoreSummary[];
      currentStore: StoreSummary | null;
      activeCashSession: CashSessionSummary | null;
    }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request(`/api/v1/staff/context${q}`);
    },

    getCatalog: (storeId?: string, channel?: string): Promise<any> => {
      const params = new URLSearchParams();
      if (storeId) params.set("storeId", storeId);
      if (channel) params.set("channel", channel);
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request(`/api/v1/staff/catalog${q}`);
    },

    getOrders: (query: { storeId?: string; status?: string; limit?: number } = {}): Promise<{ orders: OrderListItem[] }> => {
      const params = new URLSearchParams();
      if (query.storeId) params.set("storeId", query.storeId);
      if (query.status) params.set("status", query.status);
      if (query.limit) params.set("limit", String(query.limit));
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request<{ orders: OrderListItem[] }>(`/api/v1/staff/orders${q}`);
    },

    getOrder: (orderId: string, storeId?: string): Promise<{ order: OrderSummary }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request<{ order: OrderSummary }>(`/api/v1/staff/orders/${encodeURIComponent(orderId)}${q}`);
    },

    createOrder: (input: CreateOrderInput, idempotencyKey?: string): Promise<{ order: OrderSummary; queueTicket: QueueTicketSummary }> =>
      this.request<{ order: OrderSummary; queueTicket: QueueTicketSummary }>("/api/v1/staff/orders", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "idempotency-key": idempotencyKey || crypto.randomUUID() }
      }),

    payOrder: (
      orderId: string,
      input: {
        storeId: string;
        method: "CASH" | "PROMPTPAY" | "EXTERNAL_CARD" | "MANUAL";
        amountMinor: number;
        currency?: string;
        providerReference?: string;
      },
      idempotencyKey?: string
    ): Promise<{ order: OrderSummary; queueTicket: QueueTicketSummary; receipt: any }> =>
      this.request(`/api/v1/staff/orders/${encodeURIComponent(orderId)}/pay`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "idempotency-key": idempotencyKey || crypto.randomUUID() }
      }),

    refundOrder: (
      orderId: string,
      input: { storeId: string; amountMinor: number; reason: string },
      idempotencyKey?: string
    ): Promise<{ refund: any }> =>
      this.request(`/api/v1/staff/orders/${encodeURIComponent(orderId)}/refund`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "idempotency-key": idempotencyKey || crypto.randomUUID() }
      }),

    transitionOrder: (
      orderId: string,
      input: { storeId: string; toStatus: string; expectedStatus?: string; reason?: string },
      idempotencyKey?: string
    ): Promise<{ order: OrderSummary }> =>
      this.request(`/api/v1/staff/orders/${encodeURIComponent(orderId)}/transition`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "idempotency-key": idempotencyKey || crypto.randomUUID() }
      }),

    getCurrentCashSession: (storeId?: string): Promise<{ session: CashSessionSummary | null }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request<{ session: CashSessionSummary | null }>(`/api/v1/staff/cash-sessions/current${q}`);
    },

    openCashSession: (input: {
      storeId: string;
      openingAmountMinor: number;
      notes?: string;
    }): Promise<{ session: CashSessionSummary }> =>
      this.request<{ session: CashSessionSummary }>("/api/v1/staff/cash-sessions/open", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    recordCashMovement: (input: {
      storeId: string;
      cashSessionId: string;
      movementType: "IN" | "OUT" | "PAID_IN" | "PAID_OUT";
      amountMinor: number;
      reason: string;
    }): Promise<{ movement: CashMovementSummary }> =>
      this.request<{ movement: CashMovementSummary }>("/api/v1/staff/cash-sessions/movement", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    closeCashSession: (input: {
      storeId: string;
      cashSessionId: string;
      countedAmountMinor: number;
      notes?: string;
    }): Promise<{ session: CashSessionSummary }> =>
      this.request<{ session: CashSessionSummary }>("/api/v1/staff/cash-sessions/close", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    getCashSessionsHistory: (storeId?: string, limit?: number): Promise<{ sessions: CashSessionSummary[] }> => {
      const params = new URLSearchParams();
      if (storeId) params.set("storeId", storeId);
      if (limit) params.set("limit", String(limit));
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request<{ sessions: CashSessionSummary[] }>(`/api/v1/staff/cash-sessions/history${q}`);
    },

    createDailyClosing: (input: { storeId: string; closingDate: string }): Promise<{ closing: DailyClosingSummary }> =>
      this.request<{ closing: DailyClosingSummary }>("/api/v1/staff/reports/closing/daily", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    getDailyClosing: (storeId?: string, date?: string): Promise<{ closing: DailyClosingSummary | null }> => {
      const params = new URLSearchParams();
      if (storeId) params.set("storeId", storeId);
      if (date) params.set("date", date);
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request<{ closing: DailyClosingSummary | null }>(`/api/v1/staff/reports/closing/daily${q}`);
    },

    getDailyClosingHistory: (storeId?: string, limit?: number): Promise<{ closings: DailyClosingSummary[] }> => {
      const params = new URLSearchParams();
      if (storeId) params.set("storeId", storeId);
      if (limit) params.set("limit", String(limit));
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request<{ closings: DailyClosingSummary[] }>(`/api/v1/staff/reports/closing/history${q}`);
    },

    getReportsSummary: (storeId?: string, date?: string): Promise<{ summary: any }> => {
      const params = new URLSearchParams();
      if (storeId) params.set("storeId", storeId);
      if (date) params.set("date", date);
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request<{ summary: any }>(`/api/v1/staff/reports/summary${q}`);
    },

    getVenues: (storeId?: string): Promise<{ venues: VenueSummary[] }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request<{ venues: VenueSummary[] }>(`/api/v1/staff/booking/venues${q}`);
    },

    createVenue: (input: {
      storeId?: string;
      name: string;
      slug: string;
      description?: string;
      address?: string;
      timezone?: string;
      slotDurationMinutes?: number;
    }): Promise<{ venue: VenueSummary }> =>
      this.request<{ venue: VenueSummary }>("/api/v1/staff/booking/venues", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    getResources: (venueId: string): Promise<{ resources: BookableResourceSummary[] }> =>
      this.request<{ resources: BookableResourceSummary[] }>(`/api/v1/staff/booking/resources?venueId=${encodeURIComponent(venueId)}`),

    createResource: (input: {
      venueId: string;
      name: string;
      type: "COURT" | "ROOM" | "STUDIO" | "TABLE" | "EQUIPMENT";
      capacity?: number;
      basePriceMinor?: number;
    }): Promise<{ resource: BookableResourceSummary }> =>
      this.request<{ resource: BookableResourceSummary }>("/api/v1/staff/booking/resources", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    getBookings: (venueId: string, query: { date?: string; resourceId?: string } = {}): Promise<{ bookings: BookingSummary[] }> => {
      const params = new URLSearchParams();
      params.set("venueId", venueId);
      if (query.date) params.set("date", query.date);
      if (query.resourceId) params.set("resourceId", query.resourceId);
      return this.request<{ bookings: BookingSummary[] }>(`/api/v1/staff/booking/bookings?${params.toString()}`);
    },

    createBooking: (input: {
      venueId: string;
      resourceId: string;
      customerName: string;
      customerPhone?: string;
      customerEmail?: string;
      startAt: string;
      endAt: string;
      amountMinor: number;
      notes?: string;
      orderId?: string;
    }): Promise<{ booking: BookingSummary }> =>
      this.request<{ booking: BookingSummary }>("/api/v1/staff/booking/bookings", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    checkinBooking: (bookingId: string, code?: string): Promise<{ booking: BookingSummary }> =>
      this.request<{ booking: BookingSummary }>(`/api/v1/staff/booking/bookings/${encodeURIComponent(bookingId)}/checkin`, {
        method: "POST",
        body: JSON.stringify({ ...(code ? { code } : {}) })
      }),

    getWaitlists: (venueId: string): Promise<{ waitlists: BookingWaitlistSummary[] }> =>
      this.request<{ waitlists: BookingWaitlistSummary[] }>(`/api/v1/staff/booking/waitlists?venueId=${encodeURIComponent(venueId)}`),

    addToWaitlist: (input: {
      venueId: string;
      resourceId?: string;
      customerName: string;
      customerPhone?: string;
      customerEmail?: string;
      partySize: number;
      requestedSlot: string;
      notes?: string;
    }): Promise<{ waitlist: BookingWaitlistSummary }> =>
      this.request<{ waitlist: BookingWaitlistSummary }>("/api/v1/staff/booking/waitlists", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    updateWaitlistStatus: (waitlistId: string, status: string): Promise<{ waitlist: BookingWaitlistSummary }> =>
      this.request<{ waitlist: BookingWaitlistSummary }>(`/api/v1/staff/booking/waitlists/${encodeURIComponent(waitlistId)}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      }),

    getQueueTickets: (storeId?: string, status?: string): Promise<{ tickets: QueueTicketSummary[] }> => {
      const params = new URLSearchParams();
      if (storeId) params.set("storeId", storeId);
      if (status) params.set("status", status);
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request<{ tickets: QueueTicketSummary[] }>(`/api/v1/staff/queue/tickets${q}`);
    },

    transitionQueueTicket: (ticketId: string, status: string): Promise<{ ticket: QueueTicketSummary }> =>
      this.request<{ ticket: QueueTicketSummary }>(`/api/v1/staff/queue/tickets/${encodeURIComponent(ticketId)}/transition`, {
        method: "POST",
        body: JSON.stringify({ status })
      }),

    getPreparationStations: (storeId?: string): Promise<{ stations: PreparationStationSummary[] }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request<{ stations: PreparationStationSummary[] }>(`/api/v1/staff/preparation/stations${q}`);
    },

    getPreparationTasks: (storeId?: string, query: { stationId?: string; status?: string } = {}): Promise<{ tasks: PreparationTaskSummary[] }> => {
      const params = new URLSearchParams();
      if (storeId) params.set("storeId", storeId);
      if (query.stationId) params.set("stationId", query.stationId);
      if (query.status) params.set("status", query.status);
      const q = params.toString() ? `?${params.toString()}` : "";
      return this.request<{ tasks: PreparationTaskSummary[] }>(`/api/v1/staff/preparation/tasks${q}`);
    },

    completePreparationTask: (taskId: string, storeId: string): Promise<{ task: PreparationTaskSummary }> =>
      this.request<{ task: PreparationTaskSummary }>(`/api/v1/staff/preparation/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: "POST",
        body: JSON.stringify({ storeId })
      }),

    getDevices: (storeId?: string): Promise<{ devices: DeviceSummary[] }> => {
      const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      return this.request<{ devices: DeviceSummary[] }>(`/api/v1/staff/devices${q}`);
    },

    createDevice: (input: {
      storeId: string;
      name: string;
      mode: "POS" | "KIOSK" | "KDS" | "QUEUE_DISPLAY";
    }): Promise<{ device: DeviceSummary; pairingCode: string; pairingExpiresAt: string }> =>
      this.request<{ device: DeviceSummary; pairingCode: string; pairingExpiresAt: string }>("/api/v1/staff/devices", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    revokeDevice: (deviceId: string, storeId: string): Promise<{ ok: boolean }> =>
      this.request<{ ok: boolean }>(`/api/v1/staff/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: "POST",
        body: JSON.stringify({ storeId })
      })
  };

  // ==========================================
  // SURFACE 3: Public Consumer Client
  // ==========================================
  readonly public = {
    getMenu: (storeCode: string): Promise<any> =>
      this.request(`/api/v1/public/stores/${encodeURIComponent(storeCode)}/menu`),

    createOrder: (storeCode: string, input: any, idempotencyKey?: string): Promise<{ order: any; trackingToken?: string }> =>
      this.request(`/api/v1/public/stores/${encodeURIComponent(storeCode)}/orders`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "idempotency-key": idempotencyKey || crypto.randomUUID() }
      }),

    trackOrder: (token: string, storeCode: string): Promise<{ order: any }> =>
      this.request(`/api/v1/public/orders/track/${encodeURIComponent(token)}?storeCode=${encodeURIComponent(storeCode)}`),

    getVenueAvailability: (venueSlug: string, date: string): Promise<{ date: string; slots: any }> =>
      this.request(`/api/v1/public/venues/${encodeURIComponent(venueSlug)}/availability?date=${encodeURIComponent(date)}`),

    createBooking: (venueSlug: string, input: any): Promise<{ booking: any }> =>
      this.request(`/api/v1/public/venues/${encodeURIComponent(venueSlug)}/bookings`, {
        method: "POST",
        body: JSON.stringify(input)
      }),

    getQueueSnapshot: (storeCode: string): Promise<{ snapshot: QueueDisplaySnapshot }> =>
      this.request<{ snapshot: QueueDisplaySnapshot }>(`/api/v1/public/queue/${encodeURIComponent(storeCode)}/snapshot`)
  };

  // ==========================================
  // SURFACE 4: Device & Kiosk Terminal Client
  // ==========================================
  readonly device = {
    pair: (pairingCode: string): Promise<{
      device: DeviceSummary;
      deviceToken: string;
      storeCode: string;
      storeName: string;
    }> =>
      this.request("/api/v1/device/pair", {
        method: "POST",
        body: JSON.stringify({ pairingCode })
      }),

    getContext: (): Promise<{ device: DeviceSummary; store: any }> =>
      this.request("/api/v1/device/context"),

    getCatalog: (): Promise<any> =>
      this.request("/api/v1/device/catalog"),

    createOrder: (input: any, idempotencyKey?: string): Promise<{ order: any; trackingToken?: string }> =>
      this.request("/api/v1/device/orders", {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "idempotency-key": idempotencyKey || crypto.randomUUID() }
      }),

    getPreparation: (): Promise<{ stations: any[]; tasks: any[] }> =>
      this.request("/api/v1/device/preparation")
  };
}

export const gateway = new GatewayClient();

export function createAevoClient(config: GatewayClientConfig = {}): GatewayClient {
  return new GatewayClient(config);
}
