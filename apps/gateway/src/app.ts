import { randomUUID } from "node:crypto";
import { AuthSessionManager, AuthenticationError, AuthService, defineAbilityFor, hasPermission, requirePlatformPermission, SessionManagerError } from "@aevo/auth";
import type { AuthenticatedUser, ManagedAuthSession } from "@aevo/auth";
import type { AppConfig } from "@aevo/config";
import { deviceModes, navigationMenuTargets, platformRolePermissionDefaults, roles } from "@aevo/contracts";
import type { BillingProvider, DeviceMode, Permission, PlatformPermission, PlatformRole, Role, SessionPrincipal, WaitlistStatus } from "@aevo/contracts";
import type { Database, PlatformQueryPrincipal } from "@aevo/db";
import {
  canAccessStore,
  resolvePrincipal,
  CatalogConflictError,
  createCategory,
  createMenu,
  createMenuItem,
  createModifierGroup,
  createProduct,
  createProductModifierGroup,
  deleteProductModifierGroup,
  listAuthorizedStores,
  listCatalog,
  createOrder,
  createPublicOrder,
  getPublicOrderByToken,
  getOrder,
  getPublicCatalog,
  listOrders,
  OrderConflictError,
  OrderNotFoundError,
  OrderValidationError,
  recordOrderPayment,
  transitionOrder,
  updateProduct,
  updateProductAvailability,
  createQueueTicket,
  getQueueTicketByOrderId,
  getQueueTicketById,
  listQueueTickets,
  transitionQueueTicket,
  getQueueDisplaySnapshot,
  QueueError,
  listPreparationStations,
  listPreparationTasks,
  completePreparationTask,
  routeOrderToStations,
  checkOrderReadiness,
  PreparationError,
  createReceiptFromOrder,
  getReceiptById,
  getReceiptByOrderId,
  reprintReceipt,
  voidReceipt,
  formatReceiptThermalText,
  recordOrderRefund,
  RefundError,
  getCurrentCashSession,
  openCashSession,
  recordCashMovement,
  closeCashSession,
  listCashSessions,
  createDailyClosing,
  getDailyClosing,
  listDailyClosings,
  listDevices,
  createDevice,
  findPairingDevice,
  pairDevice,
  findDeviceByTokenHash,
  touchDevice,
  revokeDevice,
  listMembers,
  updateMember,
  listAuditLogs,
  writeAuditLog,
  listApps,
  listOrganizationSubscriptions,
  getAppEntitlement,
  listVenues,
  createVenue,
  listResources,
  createResource,
  listBookings,
  createBooking,
  checkinBooking,
  getVenueAvailability,
  listWaitlists,
  addToWaitlist,
  updateWaitlistStatus,
  listUserOrganizations,
  listNavigationFavorites,
  listAuthorizedNavigationFavorites,
  upsertNavigationFavorite,
  deleteNavigationFavorite,
  getUserPreferences,
  updateUserPreferences,
  createOrganization,
  listOrganizationStores,
  createStore,
  OrganizationLifecycleError,
  updateStore,
  deleteStore,
  getOrganizationProfile,
  updateOrganization,
  getOrganizationStats,
  getOrganizationOverviewMetrics,
  getStoreOverviewMetrics,
  createInvitation,
  listInvitations,
  revokeInvitation,
  acceptInvitation,
  createMember,
  deleteMember,
  listOrganizationDevices,
  StripeBillingAdapter,
  MockBillingAdapter,
  recordBillingWebhookEvent,
  getBillingCustomer,
  DatabaseSchemaError,
  throwDatabaseError,
  getOrCreateOnboardingSession,
  updateOnboardingObjectives,
  setupOnboardingOrganization,
  setupOnboardingStore,
  setupOnboardingApps,
  setupOnboardingBooking,
  markOnboardingStep,
  getSetupChecklist,
  completeOnboardingSession,
  checkAppEntitlement,
  getPlatformOverview,
  listAdminOrganizations,
  listAdminStores,
  updateAdminOrganization,
  listAdminUsers,
  updateAdminUserStatus,
  getPlatformUserRole,
  writeStructuredAuditLog,
  createImpersonationSession,
  verifyImpersonationToken,
  revokeImpersonationSession,
  listAdminSubscriptions,
  processStripeWebhookEvent,
  syncPlanEntitlements,
  QueryPlatformError,
  listQueryModels,
  listPlatformQueryModels,
  executeQuery,
  executePlatformQuery,
  listQueryHistory,
  createSavedQuery,
  listSavedQueries,
  archiveSavedQuery,
  createExportTemplate,
  listExportTemplates,
  archiveExportTemplate,
  createImportJob,
  listImportJobs,
  getImportJobDetails,
  updateImportMappings,
  confirmImportJob,
  processImportJob,
  cancelImportJob,
  getImportErrorCsv,
  createExportJob,
  processExportJob,
  listExportJobs,
  getExportJob
} from "@aevo/db";
import {
  resolveOrganizationEntitlements,
  checkFeatureEntitlement,
  requireFeatureEntitlement,
  recordUsage,
  overrideOrganizationEntitlement,
  EntitlementError
} from "@aevo/entitlements";
import { InvalidOrderTransitionError } from "@aevo/ordering";
import { parseQueryText, QuerySyntaxError } from "@aevo/query";
import { createStoreRoomBroadcaster, type RealtimeEventName, type RealtimePayloadMap } from "@aevo/realtime";
import { calculateDailySummary, calculateHourlySales, calculateProductMix } from "@aevo/reporting";
import { Elysia, t } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { AppError, badRequest, forbidden, unauthorized } from "./errors";
import {
  clearCsrfCookie,
  clearSessionCookie,
  clientIp,
  csrfCookie,
  decodeAuthSessionCookie,
  encodeAuthSessionCookie,
  readCookie,
  sessionCookie,
  setCookies
} from "./http";
import { createLogger } from "./logger";
import { FixedWindowRateLimiter } from "./rate-limit";

export interface AppDependencies {
  config: AppConfig;
  database: Database;
  auth?: Pick<AuthService, "login" | "logout" | "resolve" | "resolveIdentity" | "refresh">
    & Partial<Pick<AuthService, "resolveIdentityByUserId">>;
  billing?: BillingProvider;
}

export function createApp(dependencies: AppDependencies) {
  const { config, database } = dependencies;
  const auth = dependencies.auth ?? new AuthService(database);
  const sessionManager = new AuthSessionManager(database, config.sessionCookieSecret, {
    idleTimeoutSeconds: config.sessionIdleTimeoutSeconds,
    absoluteTimeoutSeconds: config.sessionAbsoluteTimeoutSeconds
  });
  let billing = dependencies.billing;
  if (!billing) {
    if (config.stripeSecretKey) {
      billing = new StripeBillingAdapter({ secretKey: config.stripeSecretKey, webhookSecret: config.stripeWebhookSecret });
    } else if (config.nodeEnv === "production") {
      throw new Error("STRIPE_SECRET_KEY is required when NODE_ENV=production");
    } else {
      // Local/test-only fallback. Production never boots with a mock billing provider.
      billing = new MockBillingAdapter();
    }
  }
  const logger = createLogger(config.logLevel);
  const loginLimiter = new FixedWindowRateLimiter(10, 60_000);
  const registrationLimiter = new FixedWindowRateLimiter(5, 60_000);
  const passwordResetLimiter = new FixedWindowRateLimiter(5, 60_000);
  const publicOrderLimiter = new FixedWindowRateLimiter(10, 60_000);
  const publicReadLimiter = new FixedWindowRateLimiter(120, 60_000);
  const devicePairLimiter = new FixedWindowRateLimiter(12, 60_000);
  const secureCookie = config.nodeEnv === "production";
  const cookieSameSite = config.sessionCookieSameSite ?? "lax";
  const catalogChannelSchema = t.Union([
    t.Literal("POS"), t.Literal("QR"), t.Literal("KIOSK"),
    t.Literal("PICKUP"), t.Literal("STAFF"), t.Literal("API")
  ]);

  function setSessionCookies(set: { headers: Record<string, string | number | string[]> }, managed: { session: { sessionToken: string; absoluteExpiresAt: Date }; csrfToken: string }): void {
    setCookies(set, [
      sessionCookie(
        config.sessionCookieName,
        encodeAuthSessionCookie({ sessionToken: managed.session.sessionToken }),
        managed.session.absoluteExpiresAt,
        secureCookie,
        cookieSameSite
      ),
      csrfCookie(config.csrfCookieName, managed.csrfToken, managed.session.absoluteExpiresAt, secureCookie, cookieSameSite)
    ]);
  }

  function clearSessionCookies(set: { headers: Record<string, string | number | string[]> }): void {
    setCookies(set, [
      clearSessionCookie(config.sessionCookieName, secureCookie, cookieSameSite),
      clearSessionCookie(config.impersonationCookieName, secureCookie, cookieSameSite),
      clearCsrfCookie(config.csrfCookieName, secureCookie, cookieSameSite)
    ]);
  }

  async function authenticateDevice(request: Request) {
    const rawToken = request.headers.get("x-device-token")?.trim();
    if (!rawToken) throw unauthorized();
    const device = await findDeviceByTokenHash(database, await hashSecret(rawToken));
    if (!device) throw unauthorized();
    await touchDevice(database, device.id);
    return device;
  }

  function assertAllowedOrigin(request: Request): void {
    const origin = request.headers.get("origin");
    if (origin && origin !== config.webOrigin) {
      throw new AppError(403, "ORIGIN_NOT_ALLOWED", "The request origin is not allowed");
    }
  }

  interface AuthenticatedRequest {
    accessToken: string;
    identity: AuthenticatedUser;
    session: ManagedAuthSession | null;
  }

  function isMutation(request: Request): boolean {
    return !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  }

  async function readApplicationSession(request: Request): Promise<ManagedAuthSession | null> {
    const rawCookie = readCookie(request, config.sessionCookieName);
    const cookie = rawCookie ? decodeAuthSessionCookie(rawCookie) : null;
    if (!cookie) return null;
    return sessionManager.resolve(cookie.sessionToken);
  }

  async function authenticateRequest(request: Request): Promise<AuthenticatedRequest> {
    const authHeader = request.headers.get("authorization");
    let accessToken: string | null = null;
    let session: ManagedAuthSession | null = null;
    if (authHeader?.toLowerCase().startsWith("bearer ")) {
      accessToken = authHeader.slice(7).trim();
    }
    if (!accessToken) {
      session = await readApplicationSession(request);
      accessToken = session?.accessToken ?? null;
    }
    if (!accessToken) throw unauthorized();

    if (session && isMutation(request)) {
      assertAllowedOrigin(request);
      const csrfHeader = request.headers.get("x-csrf-token");
      if (!await sessionManager.verifyCsrf(session, csrfHeader)) {
        throw new AppError(403, "CSRF_INVALID", "The security token is missing or invalid");
      }
    }

    const identity = session && auth.resolveIdentityByUserId
      ? await auth.resolveIdentityByUserId(session.userId)
      : await auth.resolveIdentity(accessToken);
    if (!identity) throw unauthorized();
    return { accessToken, identity, session };
  }

  async function authenticateIdentity(request: Request): Promise<AuthenticatedUser> {
    return (await authenticateRequest(request)).identity;
  }

  async function resolveImpersonationContext(
    request: Request,
    adminUserId: string
  ): Promise<{ principal: SessionPrincipal; organizationId: string; expiresAt: string } | null> {
    const token = readCookie(request, config.impersonationCookieName);
    if (!token) return null;

    const session = await verifyImpersonationToken(database, token);
    if (!session) return null;
    if (session.adminUserId !== adminUserId) throw forbidden();

    const principal = await resolvePrincipal(database, session.targetUserId, session.organizationId);
    if (!principal) throw forbidden();

    return {
      principal,
      organizationId: session.organizationId,
      expiresAt: session.expiresAt
    };
  }

  async function requirePlatformAdmin(
    request: Request,
    permission?: PlatformPermission
  ): Promise<AuthenticatedUser & { platformRole: PlatformRole; role: PlatformRole }> {
    const identity = await authenticateIdentity(request);
    let role: PlatformRole | null = await getPlatformUserRole(database, identity.userId);
    if (!role) {
      if (config.platformAdminEmails.includes(identity.email.trim().toLowerCase())) {
        role = "SUPER_ADMIN";
      } else {
        throw forbidden();
      }
    }
    if (permission) {
      requirePlatformPermission(role, permission);
    }
    return Object.assign({}, identity, { platformRole: role, role });
  }

  function platformQueryPrincipal(
    admin: AuthenticatedUser & { platformRole: PlatformRole }
  ): PlatformQueryPrincipal {
    return {
      userId: admin.userId,
      email: admin.email,
      platformRole: admin.platformRole,
      permissions: [...platformRolePermissionDefaults[admin.platformRole]]
    };
  }

  async function authenticate(request: Request): Promise<SessionPrincipal> {
    const authenticated = await authenticateRequest(request);
    const impersonation = await resolveImpersonationContext(request, authenticated.identity.userId);
    if (impersonation) return impersonation.principal;

    const requestedOrganizationId = request.headers.get("x-organization-id") ?? request.headers.get("x-org-id") ?? undefined;
    const principal = await resolvePrincipal(
      database,
      authenticated.identity.userId,
      requestedOrganizationId,
      authenticated.identity
    );
    if (!principal) throw unauthorized();
    return principal;
  }

  async function authenticateStore(request: Request, storeId: string, permission: Permission) {
    const principal = await authenticate(request);
    if (!hasPermission(principal, permission)) throw forbidden();
    if (!await canAccessStore(database, principal, storeId)) throw forbidden();
    const rawDeviceToken = request.headers.get("x-device-token")?.trim();
    if (rawDeviceToken) {
      const device = await findDeviceByTokenHash(database, await hashSecret(rawDeviceToken));
      if (!device || device.storeId !== storeId) throw forbidden();
      await touchDevice(database, device.id);
    }
    return principal;
  }

  async function requireQueryFeature(principal: SessionPrincipal, featureKey: string): Promise<void> {
    try {
      await requireFeatureEntitlement(database, principal.organizationId, featureKey);
    } catch (error) {
      if (error instanceof EntitlementError) {
        throw new AppError(403, error.code, error.message);
      }
      throw error;
    }
  }

  async function requireQueryFeatureAndQuota(principal: SessionPrincipal, featureKey: string, quotaKey: string, quantity: number): Promise<void> {
    const entitlements = await resolveOrganizationEntitlements(database, principal.organizationId);
    if (!entitlements.features[featureKey]) {
      throw new AppError(403, "FEATURE_NOT_ENTITLED", `Feature '${featureKey}' is not enabled for this organization's subscription plan.`);
    }
    const limit = entitlements.limits[quotaKey] ?? null;
    const currentUsage = entitlements.usage[quotaKey] ?? 0;
    const normalizedQuantity = Math.max(0, Math.trunc(quantity));
    if (limit !== null && currentUsage + normalizedQuantity > limit) {
      throw new AppError(429, "QUOTA_EXCEEDED", `Usage limit exceeded for '${quotaKey}'. Current: ${currentUsage}, Limit: ${limit}`);
    }
  }

  function scheduleQueryJob(principal: SessionPrincipal, kind: "import" | "export", id: string): void {
    queueMicrotask(() => {
      void (kind === "import"
        ? processImportJob(database, principal, id)
        : processExportJob(database, principal, id)).catch((error) => {
        logger.error(`[QueryWorker] ${kind} job ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  async function requireOnboardingIdentity(request: Request): Promise<AuthenticatedUser> {
    return authenticateIdentity(request);
  }

  async function assertUserOrganization(userId: string, organizationId: string): Promise<void> {
    const organizations = await listUserOrganizations(database, userId);
    if (!organizations.some((organization) => organization.id === organizationId)) throw forbidden();
  }

  async function assertOnboardingSessionOwner(sessionId: string, userId: string): Promise<void> {
    const result = await database.client
      .from("onboarding_sessions")
      .select("user_id")
      .eq("id", sessionId)
      .maybeSingle();
    throwDatabaseError(result.error, "onboarding session ownership lookup");
    if (!result.data || String(result.data.user_id) !== userId) throw forbidden();
  }

  async function requireOrganizationSetupIdentity(request: Request, organizationId: string): Promise<AuthenticatedUser> {
    const identity = await authenticateIdentity(request);
    await assertUserOrganization(identity.userId, organizationId);
    return identity;
  }

  function rethrowCatalogError(error: unknown): never {
    if (error instanceof CatalogConflictError) throw new AppError(409, "CATALOG_CONFLICT", error.message);
    throw error;
  }

  function rethrowOrderError(error: unknown): never {
    if (error instanceof OrderValidationError || error instanceof InvalidOrderTransitionError) {
      throw new AppError(422, error instanceof InvalidOrderTransitionError ? error.code : "ORDER_VALIDATION_ERROR", error.message);
    }
    if (error instanceof OrderConflictError) throw new AppError(409, "ORDER_CONFLICT", error.message);
    if (error instanceof OrderNotFoundError) throw new AppError(404, "ORDER_NOT_FOUND", error.message);
    throw error;
  }

  function rethrowQueueError(error: unknown): never {
    if (error instanceof DatabaseSchemaError) throw error;
    if (error instanceof QueueError) throw new AppError(400, error.code, error.message);
    throw error;
  }

  function rethrowPreparationError(error: unknown): never {
    if (error instanceof DatabaseSchemaError) throw error;
    if (error instanceof PreparationError) throw new AppError(400, error.code, error.message);
    throw error;
  }

  function rethrowRefundError(error: unknown): never {
    if (error instanceof RefundError) {
      const status = error.code === "REFUND_CONFLICT" ? 409 : error.code === "ORDER_NOT_FOUND" ? 404 : 422;
      throw new AppError(status, error.code, error.message);
    }
    throw error;
  }

  function rethrowKnownOperationalError(error: unknown, status: number, code: string, fallback: string): never {
    if (error instanceof DatabaseSchemaError) throw error;
    throw new AppError(status, code, error instanceof Error ? error.message : fallback);
  }

  function rethrowOrganizationLifecycleError(error: unknown): never {
    if (error instanceof OrganizationLifecycleError) {
      const status = error.code === "STORE_QUOTA_EXCEEDED" ? 429 : error.code === "STORE_CODE_ALREADY_EXISTS" ? 409 : 422;
      throw new AppError(status, error.code, error.message);
    }
    throw error;
  }

  function idempotencyKey(request: Request): string {
    return request.headers.get("idempotency-key")?.trim() ?? "";
  }

  function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function hashSecret(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function newPairingCode(): string {
    return randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  }

  function orderActionPermission(status: string): Permission {
    if (status === "CANCELLED") return "order.void";
    if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return "refund.create";
    return "order.create";
  }

  async function broadcastStoreEvent<E extends RealtimeEventName>(
    storeId: string,
    event: E,
    payload: RealtimePayloadMap[E]
  ): Promise<void> {
    if (typeof (database.client as { channel?: unknown })?.channel === "function") {
      const broadcaster = createStoreRoomBroadcaster(database.client as never, storeId);
      await broadcaster.broadcast(event, payload);
    }
  }

  async function ensureOrderOperations(order: Awaited<ReturnType<typeof getOrder>>) {
    const existingQueueTicket = await getQueueTicketByOrderId(database, order.id);
    const queueTicket = existingQueueTicket ?? await createQueueTicket(database, {
      organizationId: order.organizationId,
      storeId: order.storeId,
      orderId: order.id,
      orderNumber: order.orderNumber
    });

    if (!existingQueueTicket) {
      await broadcastStoreEvent(order.storeId, "queue.ticket", {
        ticketId: queueTicket.id,
        queueNumber: queueTicket.queueNumber,
        status: queueTicket.status,
        occurredAt: new Date().toISOString()
      });
    }

    await routeOrderToStations(database, {
      organizationId: order.organizationId,
      storeId: order.storeId,
      orderId: order.id
    });
    return queueTicket;
  }

  function publicOrderProjection(order: Awaited<ReturnType<typeof getPublicOrderByToken>>) {
    if (!order) return null;
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentType: order.fulfillmentType,
      currency: order.currency,
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      taxMinor: order.taxMinor,
      totalMinor: order.totalMinor,
      customerName: order.customerName,
      items: order.items.map((item) => ({
        productName: item.productName,
        variantName: item.variantName,
        quantity: item.quantity,
        subtotalMinor: item.subtotalMinor,
        modifiers: item.modifiers.map((modifier) => ({ name: modifier.name }))
      })),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      publicTrackingToken: order.publicTrackingToken
    };
  }

  return new Elysia({ name: "aevo-api" })
    .use(
      swagger({
        path: "/swagger",
        documentation: {
          info: {
            title: "Aevo Canonical API Gateway",
            version: "1.0.0",
            description: "Central Gateway & Ecosystem Orchestrator API documentation for Aevo POS, Kiosk, Booking, and Hub."
          },
          tags: [
            { name: "Hub", description: "Surface 1: Hub & Subscriptions Platform Management" },
            { name: "Staff", description: "Surface 2: Staff, Cash, Catalog & Operations" },
            { name: "Public", description: "Surface 3: Public Consumer & QR Ordering" },
            { name: "Device", description: "Surface 4: Hardware, Kiosk & KDS Terminals" },
            { name: "Query", description: "Tenant-Safe Universal Query Platform" },
            { name: "Auth", description: "Authentication & Session Management" },
            { name: "Admin", description: "Privileged Platform Administration" }
          ]
        }
      })
    )
    .derive({ as: "global" }, ({ request, set }) => {
      const requestId = request.headers.get("x-request-id")?.slice(0, 128) || randomUUID();
      set.headers["x-request-id"] = requestId;
      const origin = request.headers.get("origin");
      if (!origin || origin === config.webOrigin) {
        set.headers["access-control-allow-origin"] = config.webOrigin;
        set.headers["access-control-allow-credentials"] = "true";
      }
      set.headers["vary"] = "Origin";
      set.headers["cache-control"] = "no-store";
      set.headers["x-content-type-options"] = "nosniff";
      set.headers["x-frame-options"] = "DENY";
      set.headers["referrer-policy"] = "no-referrer";
      set.headers["permissions-policy"] = "camera=(), microphone=(), geolocation=()";
      if (config.nodeEnv === "production") {
        set.headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
      }
      return { requestId };
    })
    .onAfterHandle({ as: "global" }, ({ request, requestId, set }) => {
      logger.info("http.request", { requestId, method: request.method, path: new URL(request.url).pathname, status: set.status });
    })
    .onError({ as: "global" }, ({ error, requestId, set, code }) => {
      const known = error instanceof AppError || error instanceof AuthenticationError || error instanceof DatabaseSchemaError || error instanceof SessionManagerError || error instanceof QueryPlatformError || error instanceof EntitlementError;
      const notFound = code === "NOT_FOUND";
      const status = error instanceof AppError
        ? error.status
        : error instanceof AuthenticationError
          ? 401
          : error instanceof DatabaseSchemaError
            ? 503
            : error instanceof SessionManagerError
              ? 503
            : error instanceof QueryPlatformError
              ? error.status
            : error instanceof EntitlementError
              ? (error.code === "QUOTA_EXCEEDED" ? 429 : 403)
            : notFound ? 404 : code === "VALIDATION" ? 422 : 500;
      const errorCode = error instanceof AppError
        ? error.code
        : error instanceof AuthenticationError
          ? error.code
          : error instanceof DatabaseSchemaError
            ? error.code
            : error instanceof SessionManagerError
              ? "SESSION_STORE_UNAVAILABLE"
            : error instanceof QueryPlatformError
              ? error.code
            : error instanceof EntitlementError
              ? error.code
            : notFound ? "NOT_FOUND" : code === "VALIDATION" ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
      set.status = status;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger[status >= 500 ? "error" : "warn"]("http.error", { requestId, code: errorCode, status, message: errorMessage });
      const clientMessage = error instanceof DatabaseSchemaError
        ? "ระบบฐานข้อมูลยังติดตั้งไม่ครบ กรุณาใช้คำสั่ง migration แล้วลองใหม่"
        : error instanceof SessionManagerError
          ? "ระบบ session ยังไม่พร้อม กรุณาใช้คำสั่ง migration แล้วลองใหม่"
        : error instanceof QueryPlatformError
          ? errorMessage
        : known || notFound || code === "VALIDATION" ? errorMessage : "An unexpected error occurred";
      return { error: { code: errorCode, message: clientMessage, requestId } };
    })
    .options("/*", ({ set }) => {
      set.status = 204;
      set.headers["access-control-allow-methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
      set.headers["access-control-allow-headers"] = "accept,content-type,authorization,x-organization-id,x-org-id,x-store-id,x-request-id,idempotency-key,x-device-token,x-csrf-token";
      set.headers["access-control-expose-headers"] = "x-request-id";
      set.headers["access-control-max-age"] = "600";
      return "";
    })
    .get("/health", ({ requestId }) => ({ status: "healthy", service: "aevo-canonical-gateway", requestId }))
    .get("/ready", async ({ requestId }) => {
      await database.ping();
      return { status: "ready", requestId };
    })
    .post("/api/auth/login", async ({ body, request, requestId, set }) => {
      assertAllowedOrigin(request);
      const ipAddress = clientIp(request);
      if (!loginLimiter.consume(ipAddress ?? "unknown")) throw new AppError(429, "RATE_LIMITED", "Too many login attempts");
      const result = await auth.login({
        email: body.email, password: body.password,
        ...(ipAddress ? { ipAddress } : {}),
        ...(request.headers.get("user-agent") ? { userAgent: request.headers.get("user-agent")! } : {})
      });
      const identity = await auth.resolveIdentity(result.accessToken);
      if (!identity) throw new AuthenticationError();
      const appSession = await sessionManager.create(result.userId, result, {
        ...(ipAddress ? { ipAddress } : {}),
        ...(request.headers.get("user-agent") ? { userAgent: request.headers.get("user-agent")! } : {})
      });
      setSessionCookies(set, appSession);
      setCookies(set, [clearSessionCookie(config.impersonationCookieName, secureCookie, cookieSameSite)]);
      const principal = await resolvePrincipal(database, identity.userId, undefined, identity).catch(() => null);
      logger.info("auth.login", { requestId, userId: result.userId });
      return {
        success: true,
        session: { expiresAt: appSession.session.absoluteExpiresAt.toISOString() },
        user: identity ? {
          id: identity.userId,
          email: identity.email,
          displayName: identity.displayName,
          role: principal?.role ?? null
        } : null
      };
    }, { body: t.Object({ email: t.String({ format: "email", maxLength: 320 }), password: t.String({ minLength: 1, maxLength: 1024 }) }) })
    .post("/api/auth/password/reset-request", async ({ body, request }) => {
      assertAllowedOrigin(request);
      if (!passwordResetLimiter.consume(clientIp(request) ?? "unknown")) {
        throw new AppError(429, "RATE_LIMITED", "Too many password reset attempts");
      }
      try {
        const result = await database.client.auth.resetPasswordForEmail(body.email.trim().toLowerCase(), {
          redirectTo: `${config.webOrigin}/reset-password`
        });
        if (result.error) {
          logger.warn("auth.password_reset.request_failed", { message: result.error.message });
        }
      } catch (error) {
        logger.warn("auth.password_reset.request_failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
      // Keep this response identical for known and unknown addresses.
      return { success: true };
    }, { body: t.Object({ email: t.String({ format: "email", maxLength: 320 }) }) })
    .post("/api/auth/password/update", async ({ body, request, set }) => {
      assertAllowedOrigin(request);
      const recovery = await database.client.auth.getUser(body.accessToken.trim());
      if (recovery.error || !recovery.data.user) throw unauthorized();
      const adminClient = database.client.auth?.admin;
      if (!adminClient) throw new AppError(503, "AUTH_UNAVAILABLE", "Authentication is not configured");
      const updated = await adminClient.updateUserById(recovery.data.user.id, { password: body.password });
      if (updated.error) throw new AppError(400, "PASSWORD_UPDATE_FAILED", "Unable to update the password");
      await sessionManager.revokeAll(recovery.data.user.id);
      clearSessionCookies(set);
      return { success: true };
    }, { body: t.Object({
      accessToken: t.String({ minLength: 20, maxLength: 4096 }),
      password: t.String({ minLength: 8, maxLength: 1024 })
    }) })
    .post("/api/auth/refresh", async ({ request, requestId, set }) => {
      assertAllowedOrigin(request);
      const rawCookie = readCookie(request, config.sessionCookieName);
      const cookie = rawCookie ? decodeAuthSessionCookie(rawCookie) : null;
      if (!cookie) {
        clearSessionCookies(set);
        throw unauthorized();
      }
      const current = await sessionManager.resolve(cookie.sessionToken);
      if (!current) {
        clearSessionCookies(set);
        throw unauthorized();
      }
      const csrfHeader = request.headers.get("x-csrf-token");
      if (!await sessionManager.verifyCsrf(current, csrfHeader)) {
        throw new AppError(403, "CSRF_INVALID", "The security token is missing or invalid");
      }
      let result;
      try {
        result = await auth.refresh(current.refreshToken);
      } catch {
        await sessionManager.revoke(current.sessionToken);
        clearSessionCookies(set);
        throw unauthorized();
      }
      const rotated = await sessionManager.rotate(current, result, {
        ipAddress: clientIp(request),
        userAgent: request.headers.get("user-agent") ?? undefined
      });
      setSessionCookies(set, rotated);
      set.status = 204;
      logger.info("auth.refresh", { requestId });
      return "";
    })
    .post("/api/auth/logout", async ({ request, set, requestId }) => {
      assertAllowedOrigin(request);
      const rawCookie = readCookie(request, config.sessionCookieName);
      const cookie = rawCookie ? decodeAuthSessionCookie(rawCookie) : null;
      const current = cookie ? await sessionManager.resolve(cookie.sessionToken).catch(() => null) : null;
      if (current) {
        const csrfHeader = request.headers.get("x-csrf-token");
        if (!await sessionManager.verifyCsrf(current, csrfHeader)) {
          throw new AppError(403, "CSRF_INVALID", "The security token is missing or invalid");
        }
        try {
          await auth.logout(current.accessToken, current.refreshToken);
        } catch (error) {
          // Always clear the browser cookie even if remote session revocation is
          // temporarily unavailable. The access JWT is short-lived and the
          // failure is recorded without logging the token.
          logger.warn("auth.logout.remote_failed", {
            requestId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        await sessionManager.revoke(current.sessionToken).catch((error) => {
          logger.warn("auth.logout.session_revoke_failed", { requestId, message: error instanceof Error ? error.message : String(error) });
        });
      }
      clearSessionCookies(set);
      set.status = 204;
      logger.info("auth.logout", { requestId });
      return "";
    })
    .get("/api/auth/me", async ({ request }) => {
      const authenticated = await authenticateRequest(request);
      const impersonation = await resolveImpersonationContext(request, authenticated.identity.userId);
      const principal = impersonation?.principal ?? await resolvePrincipal(
        database,
        authenticated.identity.userId,
        undefined,
        authenticated.identity
      ).catch(() => null);
      return {
        user: {
          id: authenticated.identity.userId,
          email: authenticated.identity.email,
          displayName: authenticated.identity.displayName
        },
        principal,
        effectiveUser: principal ? {
          id: principal.userId,
          email: principal.email,
          displayName: principal.displayName
        } : null,
        impersonation: impersonation ? {
          organizationId: impersonation.organizationId,
          expiresAt: impersonation.expiresAt
        } : null
      };
    })
    .get("/api/auth/sessions", async ({ request }) => {
      const authenticated = await authenticateRequest(request);
      if (!authenticated.session) throw new AppError(400, "SESSION_COOKIE_REQUIRED", "Session management requires the application session cookie");
      return {
        sessions: await sessionManager.list(authenticated.identity.userId, authenticated.session.id)
      };
    })
    .post("/api/auth/sessions/revoke-all", async ({ request, set }) => {
      const authenticated = await authenticateRequest(request);
      if (!authenticated.session) throw new AppError(400, "SESSION_COOKIE_REQUIRED", "Session management requires the application session cookie");
      await sessionManager.revokeAll(authenticated.identity.userId);
      clearSessionCookies(set);
      set.status = 204;
      return "";
    })
    .delete("/api/auth/sessions/:sessionId", async ({ request, params, set }) => {
      const authenticated = await authenticateRequest(request);
      if (!authenticated.session) throw new AppError(400, "SESSION_COOKIE_REQUIRED", "Session management requires the application session cookie");
      const revoked = await sessionManager.revokeForUser(authenticated.identity.userId, params.sessionId);
      if (!revoked) throw new AppError(404, "SESSION_NOT_FOUND", "Session not found");
      if (authenticated.session.id === params.sessionId) {
        clearSessionCookies(set);
      }
      return { success: true, revokedSessionId: params.sessionId };
    }, {
      params: t.Object({ sessionId: t.String({ format: "uuid" }) })
    })
    // ==========================================
    // CANONICAL SURFACE 1: /api/v1/hub/*
    // ==========================================
    .get("/api/v1/hub/me", async ({ request }) => {
      const authenticated = await authenticateRequest(request);
      const principal = await resolvePrincipal(
        database,
        authenticated.identity.userId,
        undefined,
        authenticated.identity
      ).catch(() => null);
      return {
        user: authenticated.identity,
        principal
      };
    })
    .get("/api/v1/hub/bootstrap", async ({ request }) => {
      const authenticated = await authenticateRequest(request);
      const requestedOrganizationId = request.headers.get("x-organization-id") ?? request.headers.get("x-org-id") ?? undefined;
      const [organizations, apps, preferences] = await Promise.all([
        listUserOrganizations(database, authenticated.identity.userId),
        listApps(database),
        getUserPreferences(database, authenticated.identity.userId)
      ]);

      let principal = await resolvePrincipal(
        database,
        authenticated.identity.userId,
        requestedOrganizationId,
        authenticated.identity
      );
      if (!principal && organizations[0]) {
        principal = await resolvePrincipal(
          database,
          authenticated.identity.userId,
          organizations[0].id,
          authenticated.identity
        );
      }

      return {
        user: authenticated.identity,
        principal,
        organizations,
        stores: principal ? await listAuthorizedStores(database, principal) : [],
        apps,
        preferences
      };
    })
    .get("/api/v1/hub/favorites", async ({ request }) => {
      const identity = await authenticateIdentity(request);
      const readModelFavorites = await listAuthorizedNavigationFavorites(database, identity.userId);
      if (readModelFavorites) return { favorites: readModelFavorites };

      // Safe rolling-deployment fallback. This path keeps the existing
      // gateway-side authorization checks until the read-model migration is
      // available on the connected database.
      const organizations = await listUserOrganizations(database, identity.userId);
      const organizationPrincipals = await Promise.all(organizations.map((organization) => resolvePrincipal(
        database,
        identity.userId,
        organization.id,
        identity
      )));
      const accessibleStoreIds = new Set((await Promise.all(organizationPrincipals.flatMap((principal) => principal ? [listAuthorizedStores(database, principal)] : [])))
        .flat()
        .map((store) => store.id));
      const favorites = await listNavigationFavorites(database, identity.userId, organizations.map((organization) => organization.id));
      return {
        favorites: favorites.filter((favorite) => favorite.kind !== "STORE" || accessibleStoreIds.has(favorite.storeId || ""))
      };
    })
    .post("/api/v1/hub/favorites", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await authenticateIdentity(request);

      if (body.kind === "MENU") {
        const menuTarget = body.targetKey
          ? navigationMenuTargets[body.targetKey as keyof typeof navigationMenuTargets]
          : undefined;
        if (!menuTarget) throw new AppError(400, "INVALID_FAVORITE_TARGET", "The requested menu cannot be pinned");
        return {
          favorite: await upsertNavigationFavorite(database, {
            userId: identity.userId,
            kind: "MENU",
            targetKey: body.targetKey ?? "",
            label: menuTarget.label,
            href: menuTarget.href,
            iconKey: menuTarget.iconKey,
            position: body.position
          })
        };
      }

      if (!body.targetId) throw new AppError(400, "FAVORITE_TARGET_REQUIRED", "A target identifier is required");

      if (body.kind === "ORGANIZATION") {
        const organizations = await listUserOrganizations(database, identity.userId);
        const organization = organizations.find((item) => item.id === body.targetId);
        if (!organization) throw forbidden();
        const principal = await resolvePrincipal(database, identity.userId, organization.id, identity);
        if (!principal || !hasPermission(principal, "organization.read")) throw forbidden();
        return {
          favorite: await upsertNavigationFavorite(database, {
            userId: identity.userId,
            organizationId: organization.id,
            kind: "ORGANIZATION",
            targetKey: `organization:${organization.id}`,
            label: organization.name,
            href: `/organize?organizationId=${encodeURIComponent(organization.id)}`,
            iconKey: "organization",
            position: body.position
          })
        };
      }

      const storeResult = await database.client
        .from("stores")
        .select("id,organization_id,name,code,status")
        .eq("id", body.targetId)
        .maybeSingle();
      throwDatabaseError(storeResult.error, "favorite store lookup");
      const store = storeResult.data as { id: string; organization_id: string; name: string; code: string; status: string } | null;
      if (!store || store.status !== "ACTIVE") throw forbidden();

      const principal = await resolvePrincipal(database, identity.userId, store.organization_id, identity);
      if (!principal || !hasPermission(principal, "store.read") || !await canAccessStore(database, principal, store.id)) {
        throw forbidden();
      }
      return {
        favorite: await upsertNavigationFavorite(database, {
          userId: identity.userId,
          organizationId: store.organization_id,
          storeId: store.id,
          kind: "STORE",
          targetKey: `store:${store.id}`,
          label: `${store.name} · ${store.code}`,
          href: `/workspace?storeId=${encodeURIComponent(store.id)}`,
          iconKey: "store",
          position: body.position
        })
      };
    }, {
      body: t.Object({
        kind: t.Union([t.Literal("ORGANIZATION"), t.Literal("STORE"), t.Literal("MENU")]),
        targetId: t.Optional(t.String({ format: "uuid" })),
        targetKey: t.Optional(t.String({ minLength: 1, maxLength: 160 })),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 10000 }))
      })
    })
    .delete("/api/v1/hub/favorites/:favoriteId", async ({ request, params, set }) => {
      assertAllowedOrigin(request);
      const identity = await authenticateIdentity(request);
      const deleted = await deleteNavigationFavorite(database, identity.userId, params.favoriteId);
      if (!deleted) throw new AppError(404, "FAVORITE_NOT_FOUND", "Favorite not found");
      set.status = 204;
      return "";
    }, {
      params: t.Object({ favoriteId: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/hub/organizations", async ({ request }) => {
      const identity = await authenticateIdentity(request);
      const organizations = await listUserOrganizations(database, identity.userId);
      return { success: true, organizations };
    })
    .post("/api/v1/hub/organizations", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await authenticateIdentity(request);
      const organization = await createOrganization(database, identity.userId, body);
      return { organization };
    }, {
      body: t.Object({
        name: t.String({ minLength: 2, maxLength: 100 }),
        slug: t.Optional(t.String({ minLength: 2, maxLength: 64 }))
      })
    })
    .get("/api/v1/hub/organizations/:organizationId", async ({ request, params }) => {
      const identity = await authenticateIdentity(request);
      await assertUserOrganization(identity.userId, params.organizationId);
      const organization = await getOrganizationProfile(database, params.organizationId);
      if (!organization) throw new AppError(404, "ORGANIZATION_NOT_FOUND", "Organization not found");
      return { organization };
    }, {
      params: t.Object({ organizationId: t.String({ format: "uuid" }) })
    })
    .patch("/api/v1/hub/organizations/:organizationId", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (principal.organizationId !== params.organizationId || !hasPermission(principal, "organization.manage")) throw forbidden();
      const organization = await updateOrganization(database, params.organizationId, body);
      if (!organization) throw new AppError(404, "ORGANIZATION_NOT_FOUND", "Organization not found");
      return { success: true, organization };
    }, {
      params: t.Object({ organizationId: t.String({ format: "uuid" }) }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 2, maxLength: 160 })),
        legalName: t.Optional(t.String({ maxLength: 200 })),
        slug: t.Optional(t.String({ minLength: 2, maxLength: 64 })),
        businessType: t.Optional(t.String({ maxLength: 100 })),
        currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
        timezone: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
        country: t.Optional(t.String({ minLength: 2, maxLength: 2 })),
        logoUrl: t.Optional(t.Union([t.String({ maxLength: 1000 }), t.Null()])),
        contactEmail: t.Optional(t.Union([t.String({ format: "email", maxLength: 320 }), t.Null()])),
        contactPhone: t.Optional(t.Union([t.String({ maxLength: 50 }), t.Null()]))
      })
    })
    .get("/api/v1/hub/stores", async ({ request, query }) => {
      const principal = await authenticate(request);
      const orgId = query.organizationId || principal.organizationId;
      if (orgId !== principal.organizationId) throw forbidden();
      const stores = await listOrganizationStores(database, orgId, principal);
      return { stores };
    }, {
      query: t.Object({
        organizationId: t.Optional(t.String({ format: "uuid" }))
      })
    })
    .post("/api/v1/hub/stores", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "organization.manage") && !hasPermission(principal, "store.create")) throw forbidden();
      const orgId = body.organizationId || principal.organizationId;
      if (orgId !== principal.organizationId) throw forbidden();
      try {
        const store = await createStore(database, orgId, body);
        return { success: true, store };
      } catch (error) {
        return rethrowOrganizationLifecycleError(error);
      }
    }, {
      body: t.Object({
        organizationId: t.Optional(t.String({ format: "uuid" })),
        name: t.String({ minLength: 1, maxLength: 160 }),
        code: t.String({ minLength: 1, maxLength: 32 }),
        timezone: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
        currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
        storeMode: t.Optional(t.Union([
          t.Literal("POS"), t.Literal("KIOSK"), t.Literal("BOOKING"),
          t.Literal("POS_BOOKING"), t.Literal("CUSTOM")
        ])),
        address: t.Optional(t.String({ maxLength: 500 })),
        phone: t.Optional(t.String({ maxLength: 50 })),
        taxId: t.Optional(t.String({ maxLength: 50 }))
      })
    })
    .patch("/api/v1/hub/stores/:storeId", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "organization.manage") && !hasPermission(principal, "store.manage")) throw forbidden();
      if (!principal.organizationId) throw forbidden();
      if (!await canAccessStore(database, principal, params.storeId)) throw forbidden();
      try {
        const store = await updateStore(database, principal.organizationId, params.storeId, body);
        if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
        return { success: true, store };
      } catch (error) {
        return rethrowOrganizationLifecycleError(error);
      }
    }, {
      params: t.Object({ storeId: t.String({ format: "uuid" }) }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 160 })),
        code: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
        timezone: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
        currency: t.Optional(t.String({ minLength: 1, maxLength: 8 })),
        storeMode: t.Optional(t.Union([
          t.Literal("POS"), t.Literal("KIOSK"), t.Literal("BOOKING"),
          t.Literal("POS_BOOKING"), t.Literal("CUSTOM")
        ])),
        address: t.Optional(t.String({ maxLength: 500 })),
        phone: t.Optional(t.String({ maxLength: 50 })),
        taxId: t.Optional(t.String({ maxLength: 50 })),
        status: t.Optional(t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]))
      })
    })
    .delete("/api/v1/hub/stores/:storeId", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "organization.manage") && !hasPermission(principal, "store.delete")) throw forbidden();
      if (!principal.organizationId) throw forbidden();
      if (!await canAccessStore(database, principal, params.storeId)) throw forbidden();
      await deleteStore(database, principal.organizationId, params.storeId);
      return { success: true, deleted: true };
    }, {
      params: t.Object({ storeId: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/me/entitlements", async ({ request }) => {
      const principal = await authenticate(request);
      const entitlements = await resolveOrganizationEntitlements(database, principal.organizationId);
      return { success: true, entitlements };
    })
    .get("/api/v1/me/preferences", async ({ request }) => {
      const authenticated = await authenticateRequest(request);
      return { preferences: await getUserPreferences(database, authenticated.identity.userId) };
    })
    .patch("/api/v1/me/preferences", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const authenticated = await authenticateRequest(request);
      return {
        preferences: await updateUserPreferences(database, authenticated.identity.userId, body)
      };
    }, {
      body: t.Object({
        locale: t.Union([t.Literal("en"), t.Literal("th")])
      })
    })
    .get("/api/v1/hub/apps", async ({ request }) => {
      await authenticateRequest(request);
      return { success: true, apps: await listApps(database) };
    })
    .get("/api/v1/hub/subscriptions", async ({ request, query }) => {
      const principal = await authenticate(request);
      return { subscriptions: await listOrganizationSubscriptions(database, principal, query.storeId) };
    }, {
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .get("/api/v1/hub/entitlements/:appId", async ({ request, params, query }) => {
      const principal = await authenticate(request);
      const [entitlement, check] = await Promise.all([
        getAppEntitlement(database, principal, params.appId, query.storeId),
        checkAppEntitlement(database, principal, params.appId, query.storeId)
      ]);
      return { entitlement, check };
    }, {
      params: t.Object({ appId: t.String({ minLength: 1, maxLength: 64 }) }),
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .get("/api/v1/hub/entitlements/:appId/check", async ({ request, params, query }) => {
      const principal = await authenticate(request);
      return await checkAppEntitlement(database, principal, params.appId, query.storeId);
    }, {
      params: t.Object({ appId: t.String({ minLength: 1, maxLength: 64 }) }),
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .get("/api/v1/hub/operating-mode", async () => {
      return {
        mode: "production",
        isUnlimitedTesting: false,
        description: "Production Mode: Commercial subscription limits active."
      };
    })
    .get("/api/v1/hub/members", async ({ request }) => {
      const principal = await authenticate(request);
      if (!hasPermission(principal, "member.manage")) throw forbidden();
      return { success: true, members: await listMembers(database, principal) };
    })
    .post("/api/v1/hub/members", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "member.manage")) throw forbidden();
      const member = await createMember(database, principal, body);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "MEMBER_INVITED",
        resourceType: "member",
        resourceId: member.membershipId,
        metadata: { email: body.email, role: body.role }
      });
      return { success: true, member };
    }, {
      body: t.Object({
        email: t.String({ format: "email" }),
        displayName: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
        role: t.Union([
          t.Literal("OWNER"), t.Literal("ADMIN"), t.Literal("BRANCH_MANAGER"),
          t.Literal("CASHIER"), t.Literal("KITCHEN"), t.Literal("STAFF"), t.Literal("VIEWER")
        ]),
        storeIds: t.Optional(t.Array(t.String({ format: "uuid" })))
      })
    })
    .patch("/api/v1/hub/members/:membershipId", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "member.manage")) throw forbidden();
      const member = await updateMember(database, principal, params.membershipId, body as never);
      return { success: true, member };
    }, {
      params: t.Object({ membershipId: t.String({ format: "uuid" }) }),
      body: t.Object({
        role: t.Optional(t.Union([
          t.Literal("OWNER"), t.Literal("ADMIN"), t.Literal("BRANCH_MANAGER"),
          t.Literal("CASHIER"), t.Literal("KITCHEN"), t.Literal("STAFF"), t.Literal("VIEWER")
        ])),
        customPermissions: t.Optional(t.Array(t.String())),
        storeIds: t.Optional(t.Array(t.String({ format: "uuid" })))
      })
    })
    .delete("/api/v1/hub/members/:membershipId", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "member.manage")) throw forbidden();
      await deleteMember(database, principal, params.membershipId);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "MEMBER_REMOVED",
        resourceType: "member",
        resourceId: params.membershipId
      });
      return { success: true };
    }, {
      params: t.Object({ membershipId: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/hub/devices", async ({ request, query }) => {
      const principal = await authenticate(request);
      if (!hasPermission(principal, "devices.manage") && !hasPermission(principal, "store.read")) throw forbidden();
      const devices = await listOrganizationDevices(database, principal.organizationId, query.storeId);
      return { success: true, devices };
    }, {
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .post("/api/v1/hub/devices", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "devices.manage") && !hasPermission(principal, "store.manage")) throw forbidden();
      const pairingCode = newPairingCode();
      const pairingExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const device = await createDevice(database, principal, {
        storeId: body.storeId,
        name: body.name,
        mode: body.mode,
        pairingCodeHash: await hashSecret(pairingCode),
        pairingExpiresAt
      });
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "DEVICE_CODE_GENERATED",
        resourceType: "device",
        resourceId: device.id,
        metadata: { name: body.name, mode: body.mode, storeId: body.storeId }
      });
      return { success: true, device, pairingCode, pairingExpiresAt };
    }, {
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        name: t.String({ minLength: 1, maxLength: 64 }),
        mode: t.Union(deviceModes.map((mode) => t.Literal(mode)) as [any, ...any[]])
      })
    })
    .post("/api/v1/hub/devices/:deviceId/revoke", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "devices.manage")) throw forbidden();
      await revokeDevice(database, principal, params.deviceId);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "DEVICE_REVOKED",
        resourceType: "device",
        resourceId: params.deviceId
      });
      return { success: true };
    }, {
      params: t.Object({ deviceId: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/hub/audit-logs", async ({ request, query }) => {
      const principal = await authenticate(request);
      if (!hasPermission(principal, "audit.read")) throw forbidden();
      const logs = await listAuditLogs(database, principal, query.limit ? Number(query.limit) : 50);
      return { logs };
    }, {
      query: t.Object({
        limit: t.Optional(t.String()),
        action: t.Optional(t.String()),
        resourceType: t.Optional(t.String())
      })
    })
    .get("/api/v1/hub/stats", async ({ request }) => {
      const principal = await authenticate(request);
      return { stats: await getOrganizationStats(database, principal.organizationId) };
    })
    .get("/api/v1/hub/overview/organization", async ({ request }) => {
      const principal = await authenticate(request);
      const stats = await getOrganizationOverviewMetrics(database, principal.organizationId);
      return { success: true, stats };
    })
    .get("/api/v1/hub/overview/store", async ({ request, query }) => {
      const principal = await authenticate(request);
      const storeId = query.storeId?.trim();
      if (!storeId || !await canAccessStore(database, principal, storeId)) throw forbidden();
      const stats = await getStoreOverviewMetrics(database, principal.organizationId, storeId);
      return { success: true, stats };
    }, {
      query: t.Object({ storeId: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/hub/workspace/store", async ({ request, query }) => {
      const principal = await authenticate(request);
      if (!hasPermission(principal, "store.read") && !hasPermission(principal, "devices.manage")) throw forbidden();
      const storeId = query.storeId.trim();
      if (!await canAccessStore(database, principal, storeId)) throw forbidden();
      const [stats, devices] = await Promise.all([
        getStoreOverviewMetrics(database, principal.organizationId, storeId),
        listDevices(database, principal, storeId)
      ]);
      return { success: true, stats, devices };
    }, {
      query: t.Object({ storeId: t.String({ format: "uuid" }) })
    })
    // ==========================================
    // CANONICAL SURFACE: /api/v1/query/*
    // ==========================================
    .get("/api/v1/query/models", async ({ request }) => {
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      return { models: await listQueryModels(database) };
    })
    .post("/api/v1/query/execute", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      const payload = body as { query: Record<string, unknown>; searchText?: string; storeId?: string };
      let query = payload.query;
      if (payload.searchText?.trim()) {
        try {
          const searchWhere = parseQueryText(payload.searchText.trim());
          const existingWhere = payload.query.where;
          query = {
            ...payload.query,
            where: existingWhere && typeof existingWhere === "object"
              ? { type: "and", children: [existingWhere, searchWhere] }
              : searchWhere
          };
        } catch (error) {
          if (error instanceof QuerySyntaxError) throw new AppError(422, "QUERY_SYNTAX_ERROR", error.message);
          throw error;
        }
      }
      const pagination = query.pagination && typeof query.pagination === "object" ? query.pagination as Record<string, unknown> : {};
      const requestedRows = typeof pagination.limit === "number" && Number.isFinite(pagination.limit) ? pagination.limit : 80;
      await requireQueryFeatureAndQuota(principal, "query_platform", "query_rows", requestedRows);
      const result = await executeQuery(database, principal, query, payload.storeId);
      if (result.rows.length > 0) await recordUsage(database, principal.organizationId, "query_rows", result.rows.length);
      return result;
    }, {
      body: t.Object({
        query: t.Record(t.String(), t.Unknown()),
        searchText: t.Optional(t.String({ maxLength: 1000 })),
        storeId: t.Optional(t.String({ format: "uuid" }))
      })
    })
    .post("/api/v1/query/parse", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      try {
        return { where: parseQueryText(body.searchText.trim()) };
      } catch (error) {
        if (error instanceof QuerySyntaxError) throw new AppError(422, "QUERY_SYNTAX_ERROR", error.message);
        throw error;
      }
    }, {
      body: t.Object({ searchText: t.String({ maxLength: 1000 }) })
    })
    .get("/api/v1/query/saved", async ({ request, query }) => {
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      return { savedQueries: await listSavedQueries(database, principal, query.model) };
    }, {
      query: t.Object({ model: t.Optional(t.String({ minLength: 1, maxLength: 120 })) })
    })
    .post("/api/v1/query/saved", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      const payload = body as {
        name: string;
        scope: "PRIVATE" | "TEAM" | "STORE" | "ORGANIZATION" | "SYSTEM";
        storeId?: string;
        query: Record<string, unknown>;
      };
      const savedQuery = await createSavedQuery(database, principal, payload);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_SAVED_CREATED",
        resourceType: "query_saved_query",
        resourceId: savedQuery.id,
        metadata: { model: savedQuery.model, scope: savedQuery.scope }
      });
      return { savedQuery };
    }, {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 160 }),
        scope: t.Union([
          t.Literal("PRIVATE"),
          t.Literal("TEAM"),
          t.Literal("STORE"),
          t.Literal("ORGANIZATION"),
          t.Literal("SYSTEM")
        ]),
        storeId: t.Optional(t.String({ format: "uuid" })),
        query: t.Record(t.String(), t.Unknown())
      })
    })
    .post("/api/v1/query/saved/:id/archive", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      await archiveSavedQuery(database, principal, params.id);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_SAVED_ARCHIVED",
        resourceType: "query_saved_query",
        resourceId: params.id
      });
      return { success: true };
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/query/history", async ({ request, query }) => {
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      return { history: await listQueryHistory(database, principal, query.model, query.limit ? Number(query.limit) : 50) };
    }, {
      query: t.Object({
        model: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
        limit: t.Optional(t.String({ pattern: "^[0-9]+$" }))
      })
    })
    .get("/api/v1/query/export-templates", async ({ request, query }) => {
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      return { templates: await listExportTemplates(database, principal, query.model) };
    }, {
      query: t.Object({ model: t.Optional(t.String({ minLength: 1, maxLength: 120 })) })
    })
    .post("/api/v1/query/export-templates", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      const template = await createExportTemplate(database, principal, body);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_EXPORT_TEMPLATE_CREATED",
        resourceType: "query_export_template",
        resourceId: template.id,
        metadata: { model: template.model, scope: template.scope, selectedFields: template.selected_fields }
      });
      return { template };
    }, {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 160 }),
        scope: t.Union([
          t.Literal("PRIVATE"),
          t.Literal("TEAM"),
          t.Literal("STORE"),
          t.Literal("ORGANIZATION"),
          t.Literal("SYSTEM")
        ]),
        storeId: t.Optional(t.String({ format: "uuid" })),
        query: t.Record(t.String(), t.Unknown()),
        selectedFields: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 160 }), { maxItems: 200 }))
      })
    })
    .post("/api/v1/query/export-templates/:id/archive", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "query.read")) throw forbidden();
      await requireQueryFeature(principal, "query_platform");
      await archiveExportTemplate(database, principal, params.id);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_EXPORT_TEMPLATE_ARCHIVED",
        resourceType: "query_export_template",
        resourceId: params.id
      });
      return { success: true };
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/query/imports", async ({ request }) => {
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_import");
      return { imports: await listImportJobs(database, principal) };
    })
    .post("/api/v1/query/imports", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      await requireQueryFeatureAndQuota(principal, "query_import", "query_import_rows", body.rows.length);
      const importResult = await createImportJob(database, principal, body);
      const importJob = importResult.importJob;
      if (importResult.created && importJob.total_rows > 0) await recordUsage(database, principal.organizationId, "query_import_rows", importJob.total_rows);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_IMPORT_PREVIEW_CREATED",
        resourceType: "query_import_job",
        resourceId: importJob.id,
        metadata: { model: importJob.model, status: importJob.status, totalRows: importJob.total_rows, validRows: importJob.valid_rows, failedRows: importJob.failed_rows }
      });
      return { importJob };
    }, {
      body: t.Object({
        model: t.String({ minLength: 1, maxLength: 120 }),
        sourceFileName: t.String({ minLength: 1, maxLength: 255 }),
        sourceContentType: t.Optional(t.String({ maxLength: 120 })),
        idempotencyKey: t.String({ minLength: 8, maxLength: 200 }),
        columns: t.Array(t.String({ minLength: 1, maxLength: 255 }), { minItems: 1, maxItems: 200 }),
        rows: t.Array(t.Record(t.String(), t.Unknown()), { minItems: 1, maxItems: 10000 }),
        mappings: t.Optional(t.Array(t.Object({
          source: t.String({ minLength: 1, maxLength: 255 }),
          field: t.String({ minLength: 1, maxLength: 160 })
        }), { maxItems: 200 })),
        storeId: t.Optional(t.String({ format: "uuid" }))
      })
    })
    .get("/api/v1/query/imports/:id", async ({ request, params }) => {
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_import");
      return getImportJobDetails(database, principal, params.id);
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) })
    })
    .patch("/api/v1/query/imports/:id/mappings", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_import");
      const details = await updateImportMappings(database, principal, params.id, body);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_IMPORT_MAPPINGS_UPDATED",
        resourceType: "query_import_job",
        resourceId: params.id,
        metadata: { mappings: details.mappings.map((mapping) => ({ source: mapping.source, field: mapping.field })), status: details.importJob.status }
      });
      return details;
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        mappings: t.Array(t.Object({
          source: t.String({ minLength: 1, maxLength: 255 }),
          field: t.String({ minLength: 1, maxLength: 160 })
        }), { maxItems: 200 })
      })
    })
    .get("/api/v1/query/imports/:id/errors/download", async ({ request, params, set }) => {
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_import");
      const errorFile = await getImportErrorCsv(database, principal, params.id);
      set.headers["content-type"] = "text/csv; charset=utf-8";
      set.headers["content-disposition"] = `attachment; filename="${errorFile.fileName.replaceAll('"', "")}"`;
      return errorFile.content;
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) })
    })
    .post("/api/v1/query/imports/:id/confirm", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_import");
      const importJob = await confirmImportJob(database, principal, params.id);
      scheduleQueryJob(principal, "import", importJob.id);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_IMPORT_CONFIRMED",
        resourceType: "query_import_job",
        resourceId: importJob.id,
        metadata: { model: importJob.model, processedRows: importJob.processed_rows }
      });
      return { importJob };
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) })
    })
    .post("/api/v1/query/imports/:id/cancel", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_import");
      await cancelImportJob(database, principal, params.id);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_IMPORT_CANCELLED",
        resourceType: "query_import_job",
        resourceId: params.id
      });
      return { success: true };
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/query/exports", async ({ request }) => {
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_export");
      return { exports: await listExportJobs(database, principal) };
    })
    .post("/api/v1/query/exports", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      const queryInput = body.query && typeof body.query === "object" ? body.query as Record<string, unknown> : {};
      const pagination = queryInput.pagination && typeof queryInput.pagination === "object" ? queryInput.pagination as Record<string, unknown> : {};
      const requestedRows = typeof pagination.limit === "number" && Number.isFinite(pagination.limit) ? pagination.limit : 80;
      await requireQueryFeatureAndQuota(principal, "query_export", "query_export_rows", requestedRows);
      const exportResult = await createExportJob(database, principal, body);
      const exportJob = exportResult.exportJob;
      scheduleQueryJob(principal, "export", exportJob.id);
      if (exportResult.created && requestedRows > 0) await recordUsage(database, principal.organizationId, "query_export_rows", requestedRows);
      await writeAuditLog(database, {
        organizationId: principal.organizationId,
        userId: principal.userId,
        action: "QUERY_EXPORT_CREATED",
        resourceType: "query_export_job",
        resourceId: exportJob.id,
        metadata: { model: exportJob.model, format: exportJob.format, totalRows: exportJob.total_rows }
      });
      return { exportJob };
    }, {
      body: t.Object({
        query: t.Record(t.String(), t.Unknown()),
        selectedFields: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 160 }), { maxItems: 200 })),
        idempotencyKey: t.String({ minLength: 8, maxLength: 200 }),
        format: t.Union([t.Literal("CSV"), t.Literal("JSON"), t.Literal("XLSX")]),
        storeId: t.Optional(t.String({ format: "uuid" }))
      })
    })
    .get("/api/v1/query/exports/:id", async ({ request, params }) => {
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_export");
      return { exportJob: await getExportJob(database, principal, params.id) };
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/query/exports/:id/download", async ({ request, params, set }) => {
      const principal = await authenticate(request);
      await requireQueryFeature(principal, "query_export");
      const exportJob = await getExportJob(database, principal, params.id, true);
      if (!exportJob.content) throw new AppError(409, "EXPORT_NOT_READY", "Export content is not ready");
      set.headers["content-type"] = exportJob.content_type;
      set.headers["content-disposition"] = `attachment; filename="${exportJob.file_name.replaceAll("\"", "")}"`;
      return exportJob.content_encoding === "base64" ? decodeBase64(exportJob.content) : exportJob.content;
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/hub/invitations", async ({ request, query }) => {
      const principal = await authenticate(request);
      const invitations = await listInvitations(database, principal, (query as any)?.storeId?.trim());
      return { success: true, invitations };
    })
    .post("/api/v1/hub/invitations", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      const payload = body as any;
      const invitation = await createInvitation(database, principal, {
        email: payload.email,
        role: payload.role,
        scopeType: payload.scopeType,
        storeId: payload.storeId
      });
      return { success: true, invitation };
    })
    .post("/api/v1/hub/invitations/:id/revoke", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      await revokeInvitation(database, principal, params.id);
      return { success: true };
    })
    .post("/api/v1/hub/invitations/:id/accept", async ({ request, params }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      await acceptInvitation(database, principal.userId, params.id);
      return { success: true };
    })
    .get("/api/v1/hub/billing/current", async ({ request }) => {
      const principal = await authenticate(request);
      const subRes = await database.client
        .from("subscriptions")
        .select("*, plan:plans(*)")
        .eq("organization_id", principal.organizationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const entitlements = await resolveOrganizationEntitlements(database, principal.organizationId);
      const customer = await getBillingCustomer(database, principal.organizationId);
      const plansRes = await database.client.from("plans").select("*").eq("status", "ACTIVE");
      return {
        success: true,
        subscription: subRes.data || {
          plan_id: "starter",
          status: "active",
          organization_id: principal.organizationId
        },
        plan: (subRes.data as any)?.plan || { name: "Starter Tier" },
        entitlements,
        customer,
        availablePlans: plansRes.data || []
      };
    })
    .post("/api/v1/hub/billing/portal", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "organization.manage")) throw forbidden();
      let customer = await getBillingCustomer(database, principal.organizationId);
      if (!customer) {
        customer = await billing.createCustomer({
          organizationId: principal.organizationId,
          email: principal.email,
          name: principal.displayName || "Owner"
        });
      }
      const returnUrl = body.returnUrl || `${config.webOrigin}/staff/hub`;
      const url = await billing.getPortalUrl(customer.providerCustomerId, returnUrl);
      return { url };
    }, {
      body: t.Object({
        returnUrl: t.Optional(t.String())
      })
    })
    .post("/api/v1/hub/billing/checkout", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "organization.manage")) throw forbidden();
      const planId = body.planId || "business";
      let customer = await getBillingCustomer(database, principal.organizationId);
      if (!customer) {
        customer = await billing.createCustomer({
          organizationId: principal.organizationId,
          email: principal.email,
          name: principal.displayName || "Owner"
        });
      }
      const returnUrl = body.returnUrl || `${config.webOrigin}/workspace`;
      const portalUrl = await billing.getPortalUrl(customer.providerCustomerId, returnUrl);
      return { success: true, checkoutUrl: portalUrl, planId };
    }, {
      body: t.Object({
        planId: t.String(),
        returnUrl: t.Optional(t.String())
      })
    })
    .post("/api/v1/webhooks/stripe", async ({ request }) => {
      try {
        const event = await billing.verifyWebhook(request);
        const result = await processStripeWebhookEvent(database, event);
        return { received: true, ...result };
      } catch (err: any) {
        throw new AppError(400, "INVALID_WEBHOOK_SIGNATURE", err.message || "Failed to verify webhook signature");
      }
    })
    .post("/api/v1/hub/billing/webhook", async ({ request }) => {
      try {
        const event = await billing.verifyWebhook(request);
        const result = await processStripeWebhookEvent(database, event);
        return { received: true, ...result };
      } catch (err: any) {
        throw new AppError(400, "INVALID_WEBHOOK_SIGNATURE", err.message || "Failed to verify webhook signature");
      }
    })
    // ==========================================
    // CANONICAL SURFACE: /api/v1/hub/onboarding/*
    // ==========================================
    .post("/api/v1/hub/onboarding/register", async ({ body, request, requestId, set }) => {
      assertAllowedOrigin(request);
      if (!registrationLimiter.consume(clientIp(request) ?? "unknown")) {
        throw new AppError(429, "RATE_LIMITED", "Too many registration attempts");
      }
      const email = body.email.trim().toLowerCase();
      const fullName = body.fullName.trim();
      let userId: string;

      const adminClient = database.client.auth?.admin;
      if (!adminClient) throw new AppError(503, "AUTH_UNAVAILABLE", "Authentication is not configured");
      const createRes = await adminClient.createUser({
        email,
        password: body.password,
        email_confirm: true,
        user_metadata: { full_name: fullName }
      });
      if (createRes.data?.user) {
        userId = createRes.data.user.id;
      } else if (createRes.error) {
        // Supabase returns an error when the email already exists. Only allow
        // the existing identity to continue when the submitted password also
        // authenticates, preventing account takeover through profile lookup.
        const loginRes = await database.client.auth.signInWithPassword({ email, password: body.password });
        if (!loginRes.data?.user) throw new AppError(400, "REGISTRATION_FAILED", "Unable to create this account");
        userId = loginRes.data.user.id;
      } else {
        throw new AppError(400, "REGISTRATION_FAILED", "Failed to create user");
      }

      const profileResult = await database.client.from("user_profiles").upsert({
        id: userId,
        email,
        display_name: fullName
      });
      throwDatabaseError(profileResult.error, "create user profile");

      const session = await getOrCreateOnboardingSession(database, userId);
      const authSession = await auth.login({
        email,
        password: body.password,
        ipAddress: clientIp(request),
        userAgent: request.headers.get("user-agent") ?? undefined
      });
      const appSession = await sessionManager.create(authSession.userId, authSession, {
        ipAddress: clientIp(request),
        userAgent: request.headers.get("user-agent") ?? undefined
      });
      setSessionCookies(set, appSession);

      return {
        success: true,
        authSession: { expiresAt: appSession.session.absoluteExpiresAt.toISOString() },
        user: { id: userId, email, displayName: fullName },
        session
      };
    }, {
      body: t.Object({
        email: t.String({ format: "email", maxLength: 320 }),
        password: t.String({ minLength: 8, maxLength: 1024 }),
        fullName: t.String({ minLength: 1, maxLength: 200 })
      })
    })
    .get("/api/v1/hub/onboarding/session", async ({ request, query }) => {
      const identity = await requireOnboardingIdentity(request);
      const userId = identity.userId;
      const orgId = query.organizationId ?? null;
      if (orgId) await assertUserOrganization(userId, orgId);
      const session = await getOrCreateOnboardingSession(database, userId, orgId);
      return { success: true, session };
    }, {
      query: t.Object({
        organizationId: t.Optional(t.String({ format: "uuid" }))
      })
    })
    .post("/api/v1/hub/onboarding/objectives", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await requireOnboardingIdentity(request);
      await assertOnboardingSessionOwner(body.sessionId, identity.userId);
      const session = await updateOnboardingObjectives(database, body.sessionId, body.objectives as any);
      return { success: true, session };
    }, {
      body: t.Object({
        sessionId: t.String({ format: "uuid" }),
        objectives: t.Array(t.String({ minLength: 1, maxLength: 64 }))
      })
    })
    .post("/api/v1/hub/onboarding/organization", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await requireOnboardingIdentity(request);
      const userId = identity.userId;
      await assertOnboardingSessionOwner(body.sessionId, userId);
      try {
        const result = await setupOnboardingOrganization(database, body.sessionId, userId, {
          name: body.name,
          legalName: body.legalName,
          businessType: body.businessType,
          country: body.country,
          timezone: body.timezone,
          currency: body.currency,
          logoUrl: body.logoUrl,
          contactEmail: body.contactEmail,
          contactPhone: body.contactPhone
        });
        return { success: true, ...result };
      } catch (error) {
        return rethrowOrganizationLifecycleError(error);
      }
    }, {
      body: t.Object({
        sessionId: t.String({ format: "uuid" }),
        name: t.String({ minLength: 1, maxLength: 200 }),
        legalName: t.Optional(t.String({ maxLength: 200 })),
        businessType: t.Optional(t.String({ maxLength: 100 })),
        country: t.Optional(t.String({ maxLength: 10 })),
        timezone: t.Optional(t.String({ maxLength: 50 })),
        currency: t.Optional(t.String({ maxLength: 10 })),
        logoUrl: t.Optional(t.String({ maxLength: 1000 })),
        contactEmail: t.Optional(t.String({ format: "email", maxLength: 320 })),
        contactPhone: t.Optional(t.String({ maxLength: 50 }))
      })
    })
    .post("/api/v1/hub/onboarding/store", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await requireOrganizationSetupIdentity(request, body.organizationId);
      await assertOnboardingSessionOwner(body.sessionId, identity.userId);
      try {
        const result = await setupOnboardingStore(database, body.sessionId, {
          organizationId: body.organizationId,
          name: body.name,
          code: body.code,
          timezone: body.timezone,
          currency: body.currency,
          storeMode: body.storeMode,
          address: body.address,
          phone: body.phone,
          taxId: body.taxId
        });
        return { success: true, ...result };
      } catch (error) {
        return rethrowOrganizationLifecycleError(error);
      }
    }, {
      body: t.Object({
        sessionId: t.String({ format: "uuid" }),
        organizationId: t.String({ format: "uuid" }),
        name: t.String({ minLength: 1, maxLength: 200 }),
        code: t.String({ minLength: 1, maxLength: 32 }),
        timezone: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
        currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
        storeMode: t.Optional(t.Union([
          t.Literal("POS"), t.Literal("KIOSK"), t.Literal("BOOKING"),
          t.Literal("POS_BOOKING"), t.Literal("CUSTOM")
        ])),
        address: t.Optional(t.String({ maxLength: 500 })),
        phone: t.Optional(t.String({ maxLength: 50 })),
        taxId: t.Optional(t.String({ maxLength: 50 }))
      })
    })
    .post("/api/v1/hub/onboarding/apps", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await requireOrganizationSetupIdentity(request, body.organizationId);
      await assertOnboardingSessionOwner(body.sessionId, identity.userId);
      const session = await setupOnboardingApps(database, body.sessionId, body.appIds);
      return { success: true, session };
    }, {
      body: t.Object({
        sessionId: t.String({ format: "uuid" }),
        organizationId: t.String({ format: "uuid" }),
        appIds: t.Array(t.String({ minLength: 1, maxLength: 64 }))
      })
    })
    .post("/api/v1/hub/onboarding/booking-setup", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await requireOrganizationSetupIdentity(request, body.organizationId);
      await assertOnboardingSessionOwner(body.sessionId, identity.userId);
      const result = await setupOnboardingBooking(database, body.sessionId, {
        organizationId: body.organizationId,
        storeId: body.storeId,
        venueName: body.venueName,
        businessType: body.businessType,
        resourceNames: body.resourceNames,
        durationMinutes: body.durationMinutes,
        priceMinor: body.priceMinor,
        enableWaitlist: body.enableWaitlist
      });
      return { success: true, ...result };
    }, {
      body: t.Object({
        sessionId: t.String({ format: "uuid" }),
        organizationId: t.String({ format: "uuid" }),
        storeId: t.Optional(t.String({ format: "uuid" })),
        venueName: t.String({ minLength: 1, maxLength: 200 }),
        businessType: t.String({ minLength: 1, maxLength: 100 }),
        resourceNames: t.Array(t.String({ minLength: 1, maxLength: 100 })),
        durationMinutes: t.Number({ minimum: 15, maximum: 1440 }),
        priceMinor: t.Number({ minimum: 0 }),
        enableWaitlist: t.Boolean()
      })
    })
    .post("/api/v1/hub/onboarding/progress", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await requireOrganizationSetupIdentity(request, body.organizationId);
      await assertOnboardingSessionOwner(body.sessionId, identity.userId);
      const session = await markOnboardingStep(database, body.sessionId, body.step);
      return { success: true, session };
    }, {
      body: t.Object({
        sessionId: t.String({ format: "uuid" }),
        organizationId: t.String({ format: "uuid" }),
        step: t.Union([t.Literal("RESOURCES"), t.Literal("STAFF")])
      })
    })
    .get("/api/v1/hub/onboarding/checklist", async ({ request, query }) => {
      await requireOrganizationSetupIdentity(request, query.organizationId);
      const checklist = await getSetupChecklist(database, query.organizationId, query.storeId);
      return { success: true, checklist };
    }, {
      query: t.Object({
        organizationId: t.String({ format: "uuid" }),
        storeId: t.Optional(t.String({ format: "uuid" }))
      })
    })
    .post("/api/v1/hub/onboarding/complete", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const identity = await requireOnboardingIdentity(request);
      await assertOnboardingSessionOwner(body.sessionId, identity.userId);
      const session = await completeOnboardingSession(database, body.sessionId);
      return { success: true, session };
    }, {
      body: t.Object({
        sessionId: t.String({ format: "uuid" })
      })
    })

    // ==========================================
    // CANONICAL SURFACE: /api/v1/admin/* (Platform Administration Console)
    // ==========================================
    .get("/api/v1/admin/query/models", async ({ request }) => {
      assertAllowedOrigin(request);
      const admin = await requirePlatformAdmin(request);
      const permissions = new Set<string>(platformRolePermissionDefaults[admin.platformRole]);
      const models = (await listPlatformQueryModels(database))
        .filter((model) => permissions.has(model.read_permission));
      return { models };
    })
    .post("/api/v1/admin/query/execute", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const admin = await requirePlatformAdmin(request);
      const payload = body as { query: Record<string, unknown>; searchText?: string };
      let query = payload.query;
      if (payload.searchText?.trim()) {
        try {
          const searchWhere = parseQueryText(payload.searchText.trim());
          const existingWhere = payload.query.where;
          query = {
            ...payload.query,
            where: existingWhere && typeof existingWhere === "object"
              ? { type: "and", children: [existingWhere, searchWhere] }
              : searchWhere
          };
        } catch (error) {
          if (error instanceof QuerySyntaxError) throw new AppError(422, "QUERY_SYNTAX_ERROR", error.message);
          throw error;
        }
      }
      return executePlatformQuery(database, platformQueryPrincipal(admin), query);
    }, {
      body: t.Object({
        query: t.Record(t.String(), t.Unknown()),
        searchText: t.Optional(t.String({ maxLength: 1000 }))
      })
    })
    .post("/api/v1/admin/query/parse", async ({ request, body }) => {
      assertAllowedOrigin(request);
      await requirePlatformAdmin(request);
      try {
        return { where: parseQueryText(body.searchText.trim()) };
      } catch (error) {
        if (error instanceof QuerySyntaxError) throw new AppError(422, "QUERY_SYNTAX_ERROR", error.message);
        throw error;
      }
    }, {
      body: t.Object({ searchText: t.String({ maxLength: 1000 }) })
    })
    .get("/api/v1/admin/overview", async ({ request }) => {
      assertAllowedOrigin(request);
      await requirePlatformAdmin(request, "system.health");
      const overview = await getPlatformOverview(database);
      return { success: true, ...overview };
    })
    .get("/api/v1/admin/organizations", async ({ request }) => {
      assertAllowedOrigin(request);
      await requirePlatformAdmin(request, "organization.read");
      const organizations = await listAdminOrganizations(database);
      return { success: true, organizations };
    })
    .get("/api/v1/admin/stores", async ({ request }) => {
      assertAllowedOrigin(request);
      await requirePlatformAdmin(request, "organization.read");
      const stores = await listAdminStores(database);
      return { success: true, stores };
    })
    .patch("/api/v1/admin/organizations/:id", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const admin = await requirePlatformAdmin(request, "organization.suspend");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length < 3) {
        throw new AppError(400, "REASON_REQUIRED", "An administrative reason (minimum 3 characters) is required for this audit-logged mutation");
      }

      const existingRes = await database.client
        .from("organizations")
        .select("*")
        .eq("id", params.id)
        .maybeSingle();

      const before = existingRes.data || {};
      const res = await updateAdminOrganization(database, params.id, body as any);

      await writeStructuredAuditLog(database, {
        organizationId: params.id,
        adminUserId: admin.userId,
        platformRole: admin.role,
        action: "ORGANIZATION_UPDATED",
        targetType: "organization",
        targetId: params.id,
        beforeState: before,
        afterState: res.organization as any,
        reason,
        createdAt: new Date().toISOString()
      });

      return { success: true, organization: res.organization };
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        status: t.Optional(t.String()),
        maxUsers: t.Optional(t.Number()),
        maxStores: t.Optional(t.Number()),
        featureFlags: t.Optional(t.Record(t.String(), t.Boolean())),
        reason: t.Optional(t.String())
      })
    })
    .get("/api/v1/admin/subscriptions", async ({ request }) => {
      assertAllowedOrigin(request);
      await requirePlatformAdmin(request, "subscription.read");
      const subscriptions = await listAdminSubscriptions(database);
      return { success: true, subscriptions };
    })
    .patch("/api/v1/admin/subscriptions/:id", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const admin = await requirePlatformAdmin(request, "subscription.manage");
      const existingRes = await database.client
        .from("subscriptions")
        .select("*")
        .eq("id", params.id)
        .single();
      if (!existingRes.data) throw new AppError(404, "NOT_FOUND", "Subscription not found");
      const before = existingRes.data as Record<string, unknown>;

      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString()
      };
      if (body.planId) updateData.plan_id = body.planId;
      if (body.status) updateData.status = body.status;

      const updateRes = await database.client
        .from("subscriptions")
        .update(updateData)
        .eq("id", params.id)
        .select()
        .single();

      if (body.planId) {
        await syncPlanEntitlements(database, String(before.organization_id), body.planId);
      }

      await writeStructuredAuditLog(database, {
        organizationId: String(before.organization_id),
        adminUserId: admin.userId,
        platformRole: admin.role,
        action: "SUBSCRIPTION_MODIFIED",
        targetType: "subscription",
        targetId: params.id,
        beforeState: before,
        afterState: updateRes.data as any,
        reason: body.reason,
        createdAt: new Date().toISOString()
      });

      return { success: true, subscription: updateRes.data };
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        planId: t.Optional(t.String()),
        status: t.Optional(t.String()),
        reason: t.String({ minLength: 3 })
      })
    })
    .post("/api/v1/admin/entitlements/override", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const admin = await requirePlatformAdmin(request, "entitlement.override");
      await overrideOrganizationEntitlement(database, {
        organizationId: body.organizationId,
        featureKey: body.featureKey,
        isEnabled: body.isEnabled,
        limitValue: body.limitValue ?? null
      });

      await writeStructuredAuditLog(database, {
        organizationId: body.organizationId,
        adminUserId: admin.userId,
        platformRole: admin.role,
        action: "ENTITLEMENT_OVERRIDDEN",
        targetType: "organization_entitlement",
        targetId: body.featureKey,
        beforeState: {},
        afterState: { featureKey: body.featureKey, isEnabled: body.isEnabled, limitValue: body.limitValue },
        reason: body.reason,
        createdAt: new Date().toISOString()
      });

      return { success: true };
    }, {
      body: t.Object({
        organizationId: t.String({ format: "uuid" }),
        featureKey: t.String(),
        isEnabled: t.Boolean(),
        limitValue: t.Optional(t.Nullable(t.Number())),
        reason: t.String({ minLength: 3 })
      })
    })
    .post("/api/v1/admin/impersonate", async ({ request, body, set }) => {
      assertAllowedOrigin(request);
      const admin = await requirePlatformAdmin(request, "user.impersonate");
      const targetPrincipal = await resolvePrincipal(database, body.targetUserId, body.organizationId);
      if (!targetPrincipal) {
        throw new AppError(404, "IMPERSONATION_TARGET_NOT_FOUND", "The target user is not an active member of the organization");
      }
      const session = await createImpersonationSession(database, {
        adminUserId: admin.userId,
        targetUserId: body.targetUserId,
        organizationId: body.organizationId,
        reason: body.reason,
        ttlMinutes: body.ttlMinutes ?? 30
      });

      await writeStructuredAuditLog(database, {
        organizationId: body.organizationId,
        adminUserId: admin.userId,
        platformRole: admin.role,
        action: "USER_IMPERSONATED",
        targetType: "user",
        targetId: body.targetUserId,
        beforeState: {},
        afterState: { targetUserId: body.targetUserId, expiresAt: session.expiresAt },
        reason: body.reason,
        createdAt: new Date().toISOString()
      });

      setCookies(set, [
        sessionCookie(
          config.impersonationCookieName,
          session.token,
          new Date(session.expiresAt),
          secureCookie,
          cookieSameSite
        )
      ]);

      return {
        success: true,
        targetUserId: targetPrincipal.userId,
        organizationId: targetPrincipal.organizationId,
        expiresAt: session.expiresAt
      };
    }, {
      body: t.Object({
        targetUserId: t.String({ format: "uuid" }),
        organizationId: t.String({ format: "uuid" }),
        reason: t.String({ minLength: 3 }),
        ttlMinutes: t.Optional(t.Number({ minimum: 5, maximum: 60 }))
      })
    })
    .post("/api/v1/admin/impersonate/exit", async ({ request, set }) => {
      assertAllowedOrigin(request);
      const admin = await requirePlatformAdmin(request, "user.impersonate");
      const token = readCookie(request, config.impersonationCookieName);
      if (token) {
        const session = await verifyImpersonationToken(database, token);
        if (session?.adminUserId === admin.userId) {
          await revokeImpersonationSession(database, token);
        }
      }
      setCookies(set, [clearSessionCookie(config.impersonationCookieName, secureCookie, cookieSameSite)]);
      return { success: true };
    })
    .get("/api/v1/admin/users", async ({ request }) => {
      assertAllowedOrigin(request);
      await requirePlatformAdmin(request, "organization.read");
      const users = await listAdminUsers(database);
      return { success: true, users };
    })
    .patch("/api/v1/admin/users/:id", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const admin = await requirePlatformAdmin(request, "organization.manage");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length < 3) {
        throw new AppError(400, "REASON_REQUIRED", "An administrative reason (minimum 3 characters) is required for user status changes");
      }
      const res = await updateAdminUserStatus(database, params.id, body.status as "ACTIVE" | "DISABLED");

      await writeStructuredAuditLog(database, {
        adminUserId: admin.userId,
        platformRole: admin.role,
        action: "USER_STATUS_UPDATED",
        targetType: "user",
        targetId: params.id,
        beforeState: {},
        afterState: { status: body.status },
        reason,
        createdAt: new Date().toISOString()
      });

      return res;
    }, {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        status: t.Union([t.Literal("ACTIVE"), t.Literal("DISABLED")]),
        reason: t.Optional(t.String())
      })
    })
    .get("/api/v1/admin/system", async ({ request }) => {
      assertAllowedOrigin(request);
      await requirePlatformAdmin(request, "system.health");
      const overview = await getPlatformOverview(database);
      return { success: true, operatingMode: overview.operatingMode };
    })
    // ==========================================
    // CANONICAL SURFACE 2: /api/v1/staff/*
    // ==========================================
    .get("/api/v1/staff/context", async ({ request, query }) => {
      const principal = await authenticate(request);
      const stores = await listAuthorizedStores(database, principal);
      const storeId = query.storeId ?? request.headers.get("x-store-id") ?? stores[0]?.id;
      const currentStore = stores.find((s) => s.id === storeId) ?? null;
      let activeCashSession = null;
      if (currentStore) {
        try {
          activeCashSession = await getCurrentCashSession(database, principal, currentStore.id);
        } catch {
          activeCashSession = null;
        }
      }
      return { success: true, context: { principal, stores, currentStore, activeCashSession }, principal, stores, currentStore, activeCashSession };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" }))
      })
    })
    .get("/api/v1/staff/catalog", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id") ?? "cf616454-2a48-43da-815e-99e26421c679";
      const principal = await authenticateStore(request, storeId, "catalog.read");
      const catalog = await listCatalog(database, principal, storeId);
      return { success: true, ...catalog };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        channel: t.Optional(catalogChannelSchema)
      })
    })
    .post("/api/v1/staff/orders", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "order.create");
      try {
        const order = await createOrder(database, principal, body, idempotencyKey(request));
        const queueTicket = await ensureOrderOperations(order);
        return { order, queueTicket };
      } catch (error) {
        return rethrowOrderError(error);
      }
    }, {
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        channel: t.Union([t.Literal("POS"), t.Literal("QR"), t.Literal("KIOSK"), t.Literal("PICKUP"), t.Literal("STAFF"), t.Literal("API")]),
        fulfillmentType: t.Union([t.Literal("TAKEAWAY"), t.Literal("DINE_IN"), t.Literal("PICKUP")]),
        orderType: t.Optional(t.Union([t.Literal("POS"), t.Literal("KIOSK"), t.Literal("QR_ORDER"), t.Literal("BOOKING"), t.Literal("SERVICE")])),
        currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
        customerName: t.Optional(t.String({ maxLength: 120 })),
        customerPhone: t.Optional(t.String({ maxLength: 32 })),
        customerEmail: t.Optional(t.String({ maxLength: 255 })),
        notes: t.Optional(t.String({ maxLength: 500 })),
        scheduledPickupAt: t.Optional(t.String()),
        items: t.Array(t.Object({
          productId: t.String({ format: "uuid" }),
          variantId: t.Optional(t.String({ format: "uuid" })),
          menuItemId: t.Optional(t.String({ format: "uuid" })),
          modifierIds: t.Optional(t.Array(t.String({ format: "uuid" }))),
          quantity: t.Integer({ minimum: 1, maximum: 99 }),
          note: t.Optional(t.String({ maxLength: 200 }))
        }), { minItems: 1 })
      })
    })
    .get("/api/v1/staff/orders", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      const principal = await authenticateStore(request, storeId, "order.read");
      const orders = await listOrders(database, principal, storeId, {
        status: query.status as never,
        limit: query.limit ? Number(query.limit) : 20
      });
      return { orders };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        status: t.Optional(t.String()),
        limit: t.Optional(t.String())
      })
    })
    .get("/api/v1/staff/orders/:orderId", async ({ request, params, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      const principal = await authenticateStore(request, storeId, "order.read");
      const order = await getOrder(database, principal, storeId, params.orderId);
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      return { order };
    }, {
      params: t.Object({ orderId: t.String({ format: "uuid" }) }),
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .post("/api/v1/staff/orders/:orderId/pay", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "payment.receive");
      const order = await recordOrderPayment(database, principal, params.orderId, body, idempotencyKey(request));
      await broadcastStoreEvent(body.storeId, "order.payment", {
        orderId: order.id,
        paymentMethod: body.method,
        amountMinor: body.amountMinor,
        occurredAt: new Date().toISOString()
      });
      const queueTicket = await ensureOrderOperations(order);
      const receipt = await createReceiptFromOrder(database, principal, {
        orderId: order.id,
        storeId: body.storeId
      });
      return { order, queueTicket, receipt };
    }, {
      params: t.Object({ orderId: t.String({ format: "uuid" }) }),
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        method: t.Union([t.Literal("CASH"), t.Literal("PROMPTPAY"), t.Literal("EXTERNAL_CARD"), t.Literal("MANUAL")]),
        amountMinor: t.Integer({ minimum: 1, maximum: 2147483647 }),
        currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
        providerReference: t.Optional(t.String({ maxLength: 200 }))
      })
    })
    .post("/api/v1/staff/orders/:orderId/refund", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "refund.create");
      try {
        const refund = await recordOrderRefund(database, principal, {
          orderId: params.orderId,
          storeId: body.storeId,
          amountMinor: body.amountMinor,
          reason: body.reason
        }, idempotencyKey(request));
        return { refund };
      } catch (error) {
        return rethrowRefundError(error);
      }
    }, {
      params: t.Object({ orderId: t.String({ format: "uuid" }) }),
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        amountMinor: t.Integer({ minimum: 1 }),
        reason: t.String({ minLength: 1, maxLength: 255 })
      })
    })
    .post("/api/v1/staff/orders/:orderId/transition", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, orderActionPermission(body.toStatus));
      const order = await transitionOrder(database, principal, params.orderId, body, idempotencyKey(request));
      return { order };
    }, {
      params: t.Object({ orderId: t.String({ format: "uuid" }) }),
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        toStatus: t.Union([
          t.Literal("PENDING_PAYMENT"), t.Literal("PAID"), t.Literal("CONFIRMED"), t.Literal("QUEUED"),
          t.Literal("ACCEPTED"), t.Literal("PREPARING"), t.Literal("PARTIALLY_READY"), t.Literal("READY"),
          t.Literal("SERVED"), t.Literal("PICKED_UP"), t.Literal("COMPLETED"), t.Literal("CANCELLED"),
          t.Literal("REFUNDED"), t.Literal("PARTIALLY_REFUNDED"), t.Literal("NO_SHOW")
        ]),
        expectedStatus: t.Optional(t.Union([
          t.Literal("DRAFT"), t.Literal("PENDING_PAYMENT"), t.Literal("PAID"), t.Literal("CONFIRMED"),
          t.Literal("QUEUED"), t.Literal("ACCEPTED"), t.Literal("PREPARING"), t.Literal("PARTIALLY_READY"),
          t.Literal("READY"), t.Literal("SERVED"), t.Literal("PICKED_UP"), t.Literal("COMPLETED"),
          t.Literal("CANCELLED"), t.Literal("REFUNDED"), t.Literal("PARTIALLY_REFUNDED"), t.Literal("NO_SHOW")
        ])),
        reason: t.Optional(t.String({ maxLength: 500 }))
      })
    })
    .get("/api/v1/staff/cash-sessions/current", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      const principal = await authenticateStore(request, storeId, "store.read");
      const session = await getCurrentCashSession(database, principal, storeId);
      return { session };
    }, {
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .post("/api/v1/staff/cash-sessions/open", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "cash_drawer.open");
      try {
        const session = await openCashSession(database, principal, {
          storeId: body.storeId,
          openingAmountMinor: body.openingAmountMinor,
          ...(body.notes ? { notes: body.notes } : {})
        });
        return { session };
      } catch (error) {
        return rethrowKnownOperationalError(error, 400, "CASH_SESSION_OPEN_FAILED", "Failed to open cash session");
      }
    }, {
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        openingAmountMinor: t.Integer({ minimum: 0 }),
        notes: t.Optional(t.String({ maxLength: 500 }))
      })
    })
    .post("/api/v1/staff/cash-sessions/movement", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "cash_drawer.open");
      try {
        const movement = await recordCashMovement(database, principal, {
          cashSessionId: body.cashSessionId,
          storeId: body.storeId,
          movementType: body.movementType,
          amountMinor: body.amountMinor,
          reason: body.reason
        });
        return { movement };
      } catch (error) {
        return rethrowKnownOperationalError(error, 400, "CASH_MOVEMENT_FAILED", "Failed to record cash movement");
      }
    }, {
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        cashSessionId: t.String({ format: "uuid" }),
        movementType: t.Union([t.Literal("IN"), t.Literal("OUT"), t.Literal("PAID_IN"), t.Literal("PAID_OUT")]),
        amountMinor: t.Integer({ minimum: 1 }),
        reason: t.String({ minLength: 1, maxLength: 255 })
      })
    })
    .post("/api/v1/staff/cash-sessions/close", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "cash_drawer.open");
      try {
        const session = await closeCashSession(database, principal, body);
        return { session };
      } catch (error) {
        return rethrowKnownOperationalError(error, 400, "CASH_SESSION_CLOSE_FAILED", "Failed to close cash session");
      }
    }, {
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        cashSessionId: t.String({ format: "uuid" }),
        countedAmountMinor: t.Integer({ minimum: 0 }),
        notes: t.Optional(t.String({ maxLength: 500 }))
      })
    })
    .get("/api/v1/staff/cash-sessions/history", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      const principal = await authenticateStore(request, storeId, "store.read");
      const sessions = await listCashSessions(database, principal, storeId, query.limit ? Number(query.limit) : 20);
      return { sessions };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        limit: t.Optional(t.String())
      })
    })
    .post("/api/v1/staff/reports/closing/daily", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "store.manage");
      try {
        const closing = await createDailyClosing(database, principal, body);
        return { closing };
      } catch (error) {
        return rethrowKnownOperationalError(error, 400, "DAILY_CLOSING_FAILED", "Failed to generate daily closing");
      }
    }, {
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        closingDate: t.String({ minLength: 10, maxLength: 10 })
      })
    })
    .get("/api/v1/staff/reports/closing/daily", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      const principal = await authenticateStore(request, storeId, "store.read");
      const closing = await getDailyClosing(database, principal, storeId, query.date);
      return { closing };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        date: t.String({ minLength: 10, maxLength: 10 })
      })
    })
    .get("/api/v1/staff/reports/closing/history", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      const principal = await authenticateStore(request, storeId, "store.read");
      const closings = await listDailyClosings(database, principal, storeId, query.limit ? Number(query.limit) : 30);
      return { closings };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        limit: t.Optional(t.String())
      })
    })
    .get("/api/v1/staff/reports/summary", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      const principal = await authenticateStore(request, storeId, "store.read");
      const targetDate = query.date || new Date().toISOString().slice(0, 10);
      const [ordersRes, paymentsRes] = await Promise.all([
        database.client
          .from("orders")
          .select("total_minor, status")
          .eq("organization_id", principal.organizationId)
          .eq("store_id", storeId)
          .gte("created_at", `${targetDate}T00:00:00.000Z`)
          .lte("created_at", `${targetDate}T23:59:59.999Z`),
        database.client
          .from("payments")
          .select("method, amount_minor")
          .eq("organization_id", principal.organizationId)
          .eq("store_id", storeId)
          .gte("created_at", `${targetDate}T00:00:00.000Z`)
          .lte("created_at", `${targetDate}T23:59:59.999Z`)
      ]);
      throwDatabaseError(ordersRes.error, "summary report orders");
      throwDatabaseError(paymentsRes.error, "summary report payments");
      const orders = (ordersRes.data ?? []).map((r) => ({
        totalMinor: Number(r.total_minor || 0),
        status: String(r.status || "")
      }));
      const payments = (paymentsRes.data ?? []).map((r) => ({
        method: String(r.method || ""),
        amountMinor: Number(r.amount_minor || 0)
      }));
      const summary = calculateDailySummary(targetDate, orders, payments);
      return { summary };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        date: t.Optional(t.String({ minLength: 10, maxLength: 10 }))
      })
    })
    .get("/api/v1/staff/booking/venues", async ({ request, query }) => {
      const principal = await authenticate(request);
      return { venues: await listVenues(database, principal, query.storeId) };
    }, {
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .post("/api/v1/staff/booking/venues", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "store.manage")) throw forbidden();
      return { venue: await createVenue(database, principal, body) };
    }, {
      body: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        name: t.String({ minLength: 1, maxLength: 160 }),
        slug: t.String({ minLength: 1, maxLength: 64 }),
        description: t.Optional(t.String({ maxLength: 1000 })),
        address: t.Optional(t.String({ maxLength: 500 })),
        timezone: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
        slotDurationMinutes: t.Optional(t.Integer({ minimum: 15, maximum: 480 }))
      })
    })
    .get("/api/v1/staff/booking/resources", async ({ request, query }) => {
      const principal = await authenticate(request);
      return { resources: await listResources(database, principal, query.venueId) };
    }, {
      query: t.Object({ venueId: t.String({ format: "uuid" }) })
    })
    .post("/api/v1/staff/booking/resources", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      if (!hasPermission(principal, "store.manage")) throw forbidden();
      return { resource: await createResource(database, principal, body as never) };
    }, {
      body: t.Object({
        venueId: t.String({ format: "uuid" }),
        name: t.String({ minLength: 1, maxLength: 160 }),
        type: t.Union([t.Literal("COURT"), t.Literal("ROOM"), t.Literal("STUDIO"), t.Literal("TABLE"), t.Literal("EQUIPMENT")]),
        capacity: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
        basePriceMinor: t.Optional(t.Integer({ minimum: 0 }))
      })
    })
    .get("/api/v1/staff/booking/bookings", async ({ request, query }) => {
      const principal = await authenticate(request);
      return {
        bookings: await listBookings(database, principal, query.venueId, {
          ...(query.date ? { date: query.date } : {}),
          ...(query.resourceId ? { resourceId: query.resourceId } : {})
        })
      };
    }, {
      query: t.Object({
        venueId: t.String({ format: "uuid" }),
        resourceId: t.Optional(t.String({ format: "uuid" })),
        date: t.Optional(t.String({ minLength: 10, maxLength: 10 }))
      })
    })
    .post("/api/v1/staff/booking/bookings", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      return {
        booking: await createBooking(database, principal, {
          venueId: body.venueId,
          resourceId: body.resourceId,
          customerName: body.customerName,
          ...(body.customerPhone ? { customerPhone: body.customerPhone } : {}),
          ...(body.customerEmail ? { customerEmail: body.customerEmail } : {}),
          startAt: body.startAt,
          endAt: body.endAt,
          amountMinor: body.amountMinor,
          ...(body.notes ? { notes: body.notes } : {}),
          ...(body.orderId ? { orderId: body.orderId } : {})
        })
      };
    }, {
      body: t.Object({
        venueId: t.String({ format: "uuid" }),
        resourceId: t.String({ format: "uuid" }),
        customerName: t.String({ minLength: 1, maxLength: 160 }),
        customerPhone: t.Optional(t.String()),
        customerEmail: t.Optional(t.String()),
        startAt: t.String(),
        endAt: t.String(),
        amountMinor: t.Integer({ minimum: 0 }),
        notes: t.Optional(t.String()),
        orderId: t.Optional(t.String({ format: "uuid" }))
      })
    })
    .post("/api/v1/staff/booking/bookings/:bookingId/checkin", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      return { booking: await checkinBooking(database, principal, params.bookingId, body.code) };
    }, {
      params: t.Object({ bookingId: t.String({ format: "uuid" }) }),
      body: t.Object({ code: t.Optional(t.String()) })
    })
    .get("/api/v1/staff/booking/waitlists", async ({ request, query }) => {
      const principal = await authenticate(request);
      return { waitlists: await listWaitlists(database, principal, query.venueId) };
    }, {
      query: t.Object({ venueId: t.String({ format: "uuid" }) })
    })
    .post("/api/v1/staff/booking/waitlists", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      return { waitlist: await addToWaitlist(database, principal, body) };
    }, {
      body: t.Object({
        venueId: t.String({ format: "uuid" }),
        resourceId: t.Optional(t.String({ format: "uuid" })),
        customerName: t.String({ minLength: 1, maxLength: 160 }),
        customerPhone: t.String({ minLength: 6, maxLength: 32 }),
        customerEmail: t.Optional(t.String({ maxLength: 255 })),
        partySize: t.Integer({ minimum: 1, maximum: 100 }),
        requestedSlot: t.String(),
        notes: t.Optional(t.String({ maxLength: 500 }))
      })
    })
    .patch("/api/v1/staff/booking/waitlists/:waitlistId/status", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      return { waitlist: await updateWaitlistStatus(database, principal, params.waitlistId, body.status as WaitlistStatus) };
    }, {
      params: t.Object({ waitlistId: t.String({ format: "uuid" }) }),
      body: t.Object({
        status: t.Union([t.Literal("WAITING"), t.Literal("NOTIFIED"), t.Literal("SEATED"), t.Literal("CANCELLED"), t.Literal("EXPIRED")])
      })
    })
    .get("/api/v1/staff/queue/tickets", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      await authenticateStore(request, storeId, "store.read");
      return {
        tickets: await listQueueTickets(database, {
          storeId,
          ...(query.status ? { statuses: [query.status as never] } : {})
        })
      };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        status: t.Optional(t.String())
      })
    })
    .post("/api/v1/staff/queue/tickets/:ticketId/transition", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      const existing = await getQueueTicketById(database, params.ticketId);
      if (!existing) throw new AppError(404, "QUEUE_TICKET_NOT_FOUND", "Queue ticket not found");
      if (!await canAccessStore(database, principal, existing.storeId)) throw forbidden();
      return { ticket: await transitionQueueTicket(database, params.ticketId, body.status as never) };
    }, {
      params: t.Object({ ticketId: t.String({ format: "uuid" }) }),
      body: t.Object({
        status: t.Union([t.Literal("WAITING"), t.Literal("CALLING"), t.Literal("SERVED"), t.Literal("CANCELLED")])
      })
    })
    .get("/api/v1/staff/preparation/stations", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      await authenticateStore(request, storeId, "order.read");
      return { stations: await listPreparationStations(database, storeId) };
    }, {
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .get("/api/v1/staff/preparation/tasks", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      await authenticateStore(request, storeId, "order.read");
      return {
        tasks: await listPreparationTasks(database, {
          storeId,
          ...(query.stationId ? { stationId: query.stationId } : {}),
          ...(query.status ? { status: query.status as never } : {})
        })
      };
    }, {
      query: t.Object({
        storeId: t.Optional(t.String({ format: "uuid" })),
        stationId: t.Optional(t.String({ format: "uuid" })),
        status: t.Optional(t.String())
      })
    })
    .post("/api/v1/staff/preparation/tasks/:taskId/complete", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticate(request);
      const task = await completePreparationTask(database, {
        taskId: params.taskId,
        organizationId: principal.organizationId,
        storeId: body.storeId,
        completedBy: principal.userId
      });
      return { task };
    }, {
      params: t.Object({ taskId: t.String({ format: "uuid" }) }),
      body: t.Object({ storeId: t.String({ format: "uuid" }) })
    })
    .get("/api/v1/staff/devices", async ({ request, query }) => {
      const storeId = query.storeId ?? request.headers.get("x-store-id");
      if (!storeId) throw new AppError(400, "MISSING_STORE_ID", "storeId is required");
      const principal = await authenticateStore(request, storeId, "devices.manage");
      return { devices: await listDevices(database, principal, storeId) };
    }, {
      query: t.Object({ storeId: t.Optional(t.String({ format: "uuid" })) })
    })
    .post("/api/v1/staff/devices", async ({ request, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "devices.manage");
      const pairingCode = newPairingCode();
      const pairingExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const device = await createDevice(database, principal, {
        storeId: body.storeId,
        name: body.name,
        mode: body.mode,
        pairingCodeHash: await hashSecret(pairingCode),
        pairingExpiresAt
      });
      return { device, pairingCode, pairingExpiresAt };
    }, {
      body: t.Object({
        storeId: t.String({ format: "uuid" }),
        name: t.String({ minLength: 1, maxLength: 64 }),
        mode: t.Union(deviceModes.map((mode) => t.Literal(mode)) as [any, ...any[]])
      })
    })
    .post("/api/v1/staff/devices/:deviceId/revoke", async ({ request, params, body }) => {
      assertAllowedOrigin(request);
      const principal = await authenticateStore(request, body.storeId, "devices.manage");
      const revoked = await revokeDevice(database, principal, params.deviceId, body.storeId);
      if (!revoked) throw new AppError(404, "DEVICE_NOT_FOUND", "Device not found");
      return { ok: true };
    }, {
      params: t.Object({ deviceId: t.String({ format: "uuid" }) }),
      body: t.Object({ storeId: t.String({ format: "uuid" }) })
    })

    // ==========================================
    // CANONICAL SURFACE 3: /api/v1/public/*
    // ==========================================
    .get("/api/v1/public/stores/:storeCode/menu", async ({ request, params }) => {
      const ip = clientIp(request) || "127.0.0.1";
      if (!publicReadLimiter.consume(ip)) throw new AppError(429, "RATE_LIMITED", "Too many requests");
      const catalog = await getPublicCatalog(database, params.storeCode);
      return { success: true, ...(catalog ?? { categories: [], products: [] }) };
    }, {
      params: t.Object({ storeCode: t.String({ minLength: 1, maxLength: 64 }) })
    })
    .get("/api/v1/public/catalog/:storeCode", async ({ request, params }) => {
      const ip = clientIp(request) || "127.0.0.1";
      if (!publicReadLimiter.consume(ip)) throw new AppError(429, "RATE_LIMITED", "Too many requests");
      const catalog = await getPublicCatalog(database, params.storeCode);
      return { success: true, ...(catalog ?? { categories: [], products: [] }) };
    }, {
      params: t.Object({ storeCode: t.String({ minLength: 1, maxLength: 64 }) })
    })
    .post("/api/v1/public/stores/:storeCode/orders", async ({ request, params, body }) => {
      const ip = clientIp(request) || "127.0.0.1";
      if (!publicOrderLimiter.consume(ip)) throw new AppError(429, "RATE_LIMITED", "Too many orders. Please wait a moment.");
      try {
        const order = await createPublicOrder(database, { ...body, storeCode: params.storeCode }, idempotencyKey(request));
        await ensureOrderOperations(order as never);
        return { order: publicOrderProjection(order as never), trackingToken: order.publicTrackingToken };
      } catch (error) {
        return rethrowOrderError(error);
      }
    }, {
      params: t.Object({ storeCode: t.String({ minLength: 1, maxLength: 32 }) }),
      body: t.Object({
        channel: t.Union([t.Literal("QR"), t.Literal("KIOSK")]),
        fulfillmentType: t.Union([t.Literal("DINE_IN"), t.Literal("TAKEAWAY")]),
        customerName: t.Optional(t.String({ maxLength: 120 })),
        customerPhone: t.Optional(t.String({ maxLength: 32 })),
        notes: t.Optional(t.String({ maxLength: 500 })),
        items: t.Array(t.Object({
          productId: t.String({ format: "uuid" }),
          variantId: t.Optional(t.String({ format: "uuid" })),
          modifierIds: t.Optional(t.Array(t.String({ format: "uuid" }))),
          quantity: t.Integer({ minimum: 1, maximum: 99 }),
          note: t.Optional(t.String({ maxLength: 200 }))
        }), { minItems: 1 })
      })
    })
    .get("/api/v1/public/orders/track/:token", async ({ request, params, query }) => {
      const ip = clientIp(request) || "127.0.0.1";
      if (!publicReadLimiter.consume(ip)) throw new AppError(429, "RATE_LIMITED", "Too many requests");
      const order = await getPublicOrderByToken(database, query.storeCode, params.token);
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      return { order: publicOrderProjection(order) };
    }, {
      params: t.Object({ token: t.String({ minLength: 10, maxLength: 128 }) }),
      query: t.Object({ storeCode: t.String({ minLength: 1, maxLength: 32 }) })
    })
    .get("/api/v1/public/venues/:venueSlug/availability", async ({ request, params, query }) => {
      const ip = clientIp(request) || "127.0.0.1";
      if (!publicReadLimiter.consume(ip)) throw new AppError(429, "RATE_LIMITED", "Too many requests");
      const venueRes = await database.client.from("venues").select("id, organization_id").eq("slug", params.venueSlug).single();
      if (venueRes.error || !venueRes.data) throw new AppError(404, "VENUE_NOT_FOUND", "Venue not found");
      const anonPrincipal: SessionPrincipal = {
        userId: "",
        email: "anon@customer",
        organizationId: String(venueRes.data.organization_id),
        membershipId: "",
        role: "VIEWER",
        permissions: []
      };
      const slots = await getVenueAvailability(database, anonPrincipal, String(venueRes.data.id), query.date);
      return { date: query.date, slots };
    }, {
      params: t.Object({ venueSlug: t.String({ minLength: 1, maxLength: 64 }) }),
      query: t.Object({ date: t.String({ minLength: 10, maxLength: 10 }) })
    })
    .post("/api/v1/public/venues/:venueSlug/bookings", async ({ request, params, body }) => {
      const ip = clientIp(request) || "127.0.0.1";
      if (!publicOrderLimiter.consume(ip)) throw new AppError(429, "RATE_LIMITED", "Too many booking requests");
      const venueRes = await database.client.from("venues").select("id, organization_id").eq("slug", params.venueSlug).single();
      if (venueRes.error || !venueRes.data) throw new AppError(404, "VENUE_NOT_FOUND", "Venue not found");
      const anonPrincipal: SessionPrincipal = {
        userId: "",
        email: "anon@customer",
        organizationId: String(venueRes.data.organization_id),
        membershipId: "",
        role: "VIEWER",
        permissions: []
      };
      const booking = await createBooking(database, anonPrincipal, {
        venueId: String(venueRes.data.id),
        resourceId: body.resourceId,
        customerName: body.customerName,
        ...(body.customerPhone ? { customerPhone: body.customerPhone } : {}),
        ...(body.customerEmail ? { customerEmail: body.customerEmail } : {}),
        startAt: body.startsAt,
        endAt: body.endsAt,
        amountMinor: body.totalAmountMinor ?? 0
      });
      return { booking };
    }, {
      params: t.Object({ venueSlug: t.String({ minLength: 1, maxLength: 64 }) }),
      body: t.Object({
        resourceId: t.String({ format: "uuid" }),
        customerName: t.String({ minLength: 1, maxLength: 160 }),
        customerPhone: t.Optional(t.String()),
        customerEmail: t.Optional(t.String()),
        startsAt: t.String(),
        endsAt: t.String(),
        totalAmountMinor: t.Optional(t.Integer({ minimum: 0 }))
      })
    })
    .get("/api/v1/public/queue/:storeCode/snapshot", async ({ request, params }) => {
      const ip = clientIp(request) || "127.0.0.1";
      if (!publicReadLimiter.consume(ip)) throw new AppError(429, "RATE_LIMITED", "Too many requests");
      return { snapshot: await getQueueDisplaySnapshot(database, params.storeCode) };
    }, {
      params: t.Object({ storeCode: t.String({ minLength: 1, maxLength: 32 }) })
    })

    // ==========================================
    // CANONICAL SURFACE 4: /api/v1/device/*
    // ==========================================
    .post("/api/v1/device/pair", async ({ request, body }) => {
      const ip = clientIp(request) || "127.0.0.1";
      if (!devicePairLimiter.consume(ip)) throw new AppError(429, "RATE_LIMITED", "Too many pairing attempts");
      const device = await findPairingDevice(database, await hashSecret(body.pairingCode.trim().toUpperCase()));
      if (!device) throw new AppError(401, "PAIRING_CODE_INVALID", "รหัสจับคู่อุปกรณ์ไม่ถูกต้องหรือหมดอายุ");
      const deviceToken = randomUUID() + randomUUID().replaceAll("-", "");
      const paired = await pairDevice(database, device.id, await hashSecret(deviceToken));
      if (!paired) throw new AppError(409, "DEVICE_PAIRING_FAILED", "ไม่สามารถจับคู่อุปกรณ์ได้");
      const storeRes = await database.client.from("stores").select("code, name").eq("id", paired.storeId).maybeSingle();
      return {
        success: true,
        device: paired,
        deviceToken,
        storeCode: storeRes.data?.code ? String(storeRes.data.code) : "",
        storeName: storeRes.data?.name ? String(storeRes.data.name) : ""
      };
    }, {
      body: t.Object({
        pairingCode: t.String({ minLength: 4, maxLength: 32 })
      })
    })
    .get("/api/v1/device/context", async ({ request }) => {
      const device = await authenticateDevice(request);
      const storeRes = await database.client.from("stores").select("id, organization_id, name, code, timezone").eq("id", device.storeId).single();
      return { device, store: storeRes.data };
    })
    .get("/api/v1/device/catalog", async ({ request }) => {
      const device = await authenticateDevice(request);
      const storeRes = await database.client.from("stores").select("code").eq("id", device.storeId).single();
      if (!storeRes.data?.code) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
      return await getPublicCatalog(database, String(storeRes.data.code));
    })
    .post("/api/v1/device/orders", async ({ request, body }) => {
      const device = await authenticateDevice(request);
      const storeRes = await database.client.from("stores").select("code").eq("id", device.storeId).single();
      if (!storeRes.data?.code) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
      const channel = "KIOSK";
      const order = await createPublicOrder(database, { ...body, storeCode: String(storeRes.data.code), channel }, idempotencyKey(request));
      await ensureOrderOperations(order as never);
      return { order: publicOrderProjection(order as never), trackingToken: order.publicTrackingToken };
    }, {
      body: t.Object({
        fulfillmentType: t.Union([t.Literal("DINE_IN"), t.Literal("TAKEAWAY")]),
        customerName: t.Optional(t.String({ maxLength: 120 })),
        customerPhone: t.Optional(t.String({ maxLength: 32 })),
        notes: t.Optional(t.String({ maxLength: 500 })),
        items: t.Array(t.Object({
          productId: t.String({ format: "uuid" }),
          variantId: t.Optional(t.String({ format: "uuid" })),
          modifierIds: t.Optional(t.Array(t.String({ format: "uuid" }))),
          quantity: t.Integer({ minimum: 1, maximum: 99 }),
          note: t.Optional(t.String({ maxLength: 200 }))
        }), { minItems: 1 })
      })
    })
    .get("/api/v1/device/preparation", async ({ request }) => {
      const device = await authenticateDevice(request);
      const [stationRes, tasksRes] = await Promise.all([
        database.client.from("preparation_stations").select("id, name, code").eq("store_id", device.storeId),
        database.client.from("preparation_tasks").select("id, order_id, item_id, station_id, status, created_at").eq("store_id", device.storeId).neq("status", "COMPLETED").order("created_at", { ascending: true })
      ]);
      return { stations: stationRes.data ?? [], tasks: tasksRes.data ?? [] };
    });
}
