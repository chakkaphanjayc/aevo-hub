import type {
  CatalogSnapshot,
  CustomerStoreProfile,
  HubApplicationConfigField,
  HubApplicationConfigSchema,
  HubApplicationLaunchResponse,
  HubStoreApplicationConfiguration,
  ProductSummary,
  StoreApplicationAccessSummary,
  StoreDeletionRequest,
  StoreSummary
} from "@aevocado/contracts";
import type { AccessDecisionResponse } from "@aevocado/api-contract";
import { ApiClientError, isApplicationCode } from "@aevocado/contracts";
import { isAccessAllowed } from "@aevocado/app-access";
import { Breadcrumbs, Button, Dialog, Input, PermissionDeniedState, Select, StatusBadge } from "@aevocado/design-system";
import { useEffect, useState, type ReactNode } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import type { ActionFunctionArgs, ClientLoaderFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  createHubApiClient,
  requireHubAccess,
  requestCsrfHeaders,
  invalidateHubAccessCache
} from "../lib/auth.server";
import { invalidateClientCache } from "../lib/client-cache";
import { hasHubPermission, type HubLoaderData } from "../lib/auth.shared";
import { logHubEvent } from "../lib/server-log.server";

type StoreView = "overview" | "settings" | "apps" | "catalog";

interface ApplicationConnectionTest {
  application: string;
  configured: boolean;
  url?: string;
  status: "ONLINE" | "HTTP_ERROR" | "OFFLINE" | "NOT_CONFIGURED";
  latencyMs: number;
  httpStatus?: number;
  access: AccessDecisionResponse;
  checkedAt: string;
}

interface StoreLoaderData {
  hub: HubLoaderData;
  store: StoreSummary | null;
  profile: CustomerStoreProfile | null;
  deletion: StoreDeletionRequest | null;
  applications: StoreApplicationAccessSummary[];
  view: StoreView;
  catalog: CatalogSnapshot | null;
  catalogError?: string;
  permissionDenied?: "store.read";
}

type StoreActionResult =
  | {
      ok: false;
      message: string;
      code?: string;
      applicationCode?: StoreApplicationAccessSummary["applicationCode"];
    }
  | { ok: true; connection: ApplicationConnectionTest };

interface StoreSettingsBody {
  name?: string;
  code?: string;
  timezone?: string;
  currency?: string;
  storeMode?: "POS" | "KIOSK" | "BOOKING" | "POS_BOOKING" | "CUSTOM";
  address?: string;
  phone?: string;
  taxId?: string;
}

const catalogChannels = ["POS", "QR", "KIOSK", "PICKUP", "STAFF", "API"] as const;
const storeModes = ["POS", "KIOSK", "BOOKING", "POS_BOOKING", "CUSTOM"] as const;
const storeMutationIntents = new Set([
  "test-application",
  "launch-application",
  "update-store-application",
  "update-application-config",
  "update-store",
  "update-customer-profile",
  "create-product",
  "update-product",
  "update-availability",
  "create-template",
  "duplicate-store"
]);

interface StoreFeatureDescriptor {
  label: string;
  description: string;
  href?: StoreView;
}

function capabilityLabel(capability: string): string {
  return capability
    .replace(/[._-]+/gu, " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function capabilityFeature(capability: string, applicationName: string): StoreFeatureDescriptor {
  if (capability === "catalog") {
    return { label: "Products & catalog", description: "Manage products, prices, availability, and menus.", href: "catalog" };
  }
  return {
    label: capabilityLabel(capability),
    description: `${capabilityLabel(capability)} is provided by ${applicationName}.`
  };
}

function applicationFeatures(application: StoreApplicationAccessSummary): StoreFeatureDescriptor[] {
  const capabilities = application.capabilities?.filter((capability) => capability.trim().length > 0) ?? [];
  return capabilities.length > 0
    ? capabilities.map((capability) => capabilityFeature(capability, application.applicationName))
    : [{ label: application.applicationName, description: "This application has no feature manifest available yet." }];
}

function storePath(storeId: string, view?: StoreView): string {
  return `/stores/${encodeURIComponent(storeId)}${view && view !== "overview" ? `?view=${view}` : ""}`;
}

function readView(request: Request): StoreView {
  const value = new URL(request.url).searchParams.get("view");
  return value === "settings" || value === "apps" || value === "catalog" ? value : "overview";
}

function storeAppsPath(storeId: string, applicationCode?: StoreApplicationAccessSummary["applicationCode"]): string {
  return applicationCode
    ? `/stores/${encodeURIComponent(storeId)}/apps/${encodeURIComponent(applicationCode)}`
    : storePath(storeId, "apps");
}

function permissionDenied(permission: "store.read", hub: HubLoaderData, view: StoreView): StoreLoaderData {
  return { hub, store: null, profile: null, deletion: null, applications: [], view, catalog: null, permissionDenied: permission };
}

function textValue(form: FormData, name: string, maximum: number, required = false): string {
  const value = String(form.get(name) ?? "").trim();
  if (required && !value) throw new Error(`${name} is required`);
  if (value.length > maximum) throw new Error(`${name} is too long`);
  return value;
}

function optionalTextValue(form: FormData, name: string, maximum: number): string | undefined {
  const value = textValue(form, name, maximum);
  return value || undefined;
}

function optionalLineList(form: FormData, name: string, maximumItemLength: number, maximumItems: number): string[] {
  const value = String(form.get(name) ?? "");
  const items = value.split(/\r?\n|,/u).map((item) => item.trim()).filter(Boolean);
  if (items.length > maximumItems || items.some((item) => item.length > maximumItemLength)) {
    throw new Error(`${name} contains too many or too-long values`);
  }
  return [...new Set(items)];
}

function optionalNumberValue(form: FormData, name: string, minimum: number, maximum: number): number | null {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function optionalIntegerValue(form: FormData, name: string, minimum: number, maximum: number): number | null {
  const value = optionalNumberValue(form, name, minimum, maximum);
  if (value !== null && !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function optionalHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
    return parsed.toString();
  } catch {
    throw new Error("imageUrl must be an http(s) URL");
  }
}

function isCatalogChannel(value: string): value is (typeof catalogChannels)[number] {
  return catalogChannels.includes(value as (typeof catalogChannels)[number]);
}

function isStoreMode(value: string): value is (typeof storeModes)[number] {
  return storeModes.includes(value as (typeof storeModes)[number]);
}

function isStoreApplicationCode(value: string): value is StoreApplicationAccessSummary["applicationCode"] {
  return ["PLAY", "POS", "KIOSK", "QUEUE"].includes(value as StoreApplicationAccessSummary["applicationCode"]);
}

function applicationName(applicationCode: string): string {
  return applicationCode === "PLAY" ? "Aevo Play" : applicationCode === "POS" ? "Aevo POS" : applicationCode;
}

function launchFailureMessage(code: string, applicationCode: string): string {
  const name = applicationName(applicationCode);
  switch (code) {
    case "APP_ASSIGNMENT_REQUIRED":
      return `${name} is enabled for this store, but this account has no active app assignment. Assign the app in Organization settings before opening it.`;
    case "APP_ASSIGNMENT_SUSPENDED":
      return `${name} is assigned to this account, but the assignment is suspended. Ask an organization owner or manager to restore it.`;
    case "SCOPE_REQUIRED":
    case "STORE_SCOPE_REQUIRED":
      return `${name} is assigned, but this account is not authorized for the selected store. Update the store scope in Organization settings.`;
    case "STORE_APPLICATION_DISABLED":
      return `${name} is not enabled for this store anymore. Enable it in Apps & features before opening the app.`;
    case "ENTITLEMENT_REQUIRED":
    case "ENTITLEMENT_INACTIVE":
    case "ENTITLEMENT_EXPIRED":
      return `${name} is enabled for this store, but the organization entitlement is not active. Review Applications & entitlements or ask a billing administrator to activate it, then try again.`;
    case "ENTITLEMENT_LIMIT_EXCEEDED":
      return `${name} cannot be opened because this organization is at its Free tier limit: one application on one store. Disable the existing store app or upgrade the plan in Applications & entitlements.`;
    case "STORE_RETENTION_ACTIVE":
      return `${name} is paused because this store is in its deletion recovery window. Cancel the scheduled deletion in Store settings before opening the app.`;
    case "APPLICATION_NOT_READY":
      return `${name} is configured, but its API is not ready. Start the app and use Test connection before trying again.`;
    default:
      return `${name} could not be opened from this store. Review the app settings and try again.`;
  }
}

function configurationFieldValue(form: FormData, field: HubApplicationConfigField): boolean | number | string {
  const raw = String(form.get(`config.${field.key}`) ?? "").trim();
  if (field.type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error(`${field.label} must be enabled or disabled`);
    return raw === "true";
  }
  if (field.type === "integer") {
    const value = Number(raw);
    if (!Number.isInteger(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      throw new Error(`${field.label} must be a valid whole number`);
    }
    return value;
  }
  if (!raw && field.required) throw new Error(`${field.label} is required`);
  if (field.maxLength !== undefined && raw.length > field.maxLength) throw new Error(`${field.label} is too long`);
  if (field.type === "select" && !field.options?.some((option) => option.value === raw)) throw new Error(`Choose a valid ${field.label.toLowerCase()}`);
  return raw;
}

function publicSlugValue(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug)) throw new Error("Use lowercase letters, numbers, and hyphens for the public slug");
  return slug;
}

function defaultPublicSlug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63);
  return publicSlugValue(normalized || "store");
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<StoreLoaderData> {
  const storeId = params.storeId;
  const view = readView(request);
  const loaderStartedAt = performance.now();
  const hub = await requireHubAccess(request, storeId ? `/modern/stores/${encodeURIComponent(storeId)}` : "/modern/stores");
  if (!isAccessAllowed(hub.access)) return permissionDenied("store.read", hub, view);
  if (!storeId) return { hub, store: null, profile: null, deletion: null, applications: [], view, catalog: null };
  if (!hasHubPermission(hub, "store.read") && !hasHubPermission(hub, "store.manage") && !hasHubPermission(hub, "organization.manage")) {
    return permissionDenied("store.read", hub, view);
  }

  const api = createHubApiClient(request);
  try {
    // The persistent Hub sidebar is store-scoped and lists the applications
    // enabled for the current store. Keep this authoritative projection
    // available on every store view so the menu never falls back to stale
    // client flags when moving between settings, catalog, and app screens.
    const needsProfile = view === "overview" || view === "settings";
    // The persistent store sidebar is rendered by the layout for every view,
    // so the enabled-app projection must remain available even on settings
    // and catalog routes. Keep this explicit instead of allowing a view to
    // accidentally fall back to stale client flags.
    const needsApplications = true;
    const applicationsRequest = needsApplications
      ? api.request<{ applications: StoreApplicationAccessSummary[] }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}/applications`)
      : Promise.resolve({ applications: [] as StoreApplicationAccessSummary[] });
    const profileRequest: Promise<{ profile: CustomerStoreProfile | null }> = needsProfile
      ? api.request<{ profile: CustomerStoreProfile | null }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}/customer-profile`)
      : Promise.resolve({ profile: null });
    const deletionRequest: Promise<{ deletion: StoreDeletionRequest | null }> = api.request<{ deletion: StoreDeletionRequest | null }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}/deletion`);
    const existingStore = hub.stores.find((s) => s.id === storeId);
    const storeRequest: Promise<{ store: StoreSummary }> = existingStore
      ? Promise.resolve({ store: existingStore })
      : api.request<{ store: StoreSummary }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}`);
    const [storeResult, applicationResult, profileResult, deletionResult] = await Promise.all([
      storeRequest,
      applicationsRequest,
      profileRequest,
      deletionRequest
    ]);
    const applications = applicationResult.applications;
    let catalog: CatalogSnapshot | null = null;
    let catalogError: string | undefined;
    if (view === "catalog") {
      try {
        catalog = await api.request<CatalogSnapshot>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}/catalog`);
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 403) catalogError = error.message;
        else throw error;
      }
    }
    return {
      hub,
      store: storeResult.store,
      applications,
      profile: profileResult.profile,
      deletion: deletionResult.deletion,
      view,
      catalog,
      ...(catalogError ? { catalogError } : {})
    };
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) {
      return { hub, store: null, profile: null, deletion: null, applications: [], view, catalog: null };
    }
    throw error;
  } finally {
    logHubEvent("info", "store.loader.complete", {
      route: new URL(request.url).pathname,
      view,
      duration_ms: Math.round(performance.now() - loaderStartedAt)
    });
  }
}

export async function clientLoader({
  serverLoader
}: ClientLoaderFunctionArgs): Promise<StoreLoaderData> {
  // Store application access, deletion state and permissions are mutable
  // authorization data. Always obtain the current server-authorized payload.
  return await serverLoader() as StoreLoaderData;
}

export async function action({ request, params }: ActionFunctionArgs): Promise<Response | StoreActionResult> {
  invalidateHubAccessCache(request.headers.get("cookie") ?? undefined);
  invalidateClientCache();
  const storeId = params.storeId;
  const hub = await requireHubAccess(request, storeId ? `/modern/stores/${encodeURIComponent(storeId)}` : "/modern/stores");
  if (!isAccessAllowed(hub.access)) return { ok: false, message: "Hub access is required." };
  if (!storeId) return { ok: false, message: "Store context is missing." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const api = createHubApiClient(request);
  const canManage = hasHubPermission(hub, "store.manage") || hasHubPermission(hub, "organization.manage");
  const canDelete = hasHubPermission(hub, "store.delete") || hasHubPermission(hub, "organization.manage");
  const canManageCatalog = canManage || hasHubPermission(hub, "catalog.manage");

  try {
    if (storeMutationIntents.has(intent)) {
      const deletion = await api.request<{ deletion: StoreDeletionRequest | null }>(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/deletion`
      );
      if (deletion.deletion?.status === "PENDING") {
        return {
          ok: false,
          code: "STORE_RETENTION_ACTIVE",
          message: "This store is in its deletion recovery window. Cancel the scheduled deletion before changing settings, catalog, or app access."
        };
      }
    }

    if (intent === "test-application") {
      if (!hasHubPermission(hub, "store.read") && !canManage) return { ok: false, message: "Store read permission is required." };
      const applicationCode = textValue(form, "applicationCode", 16, true).toUpperCase();
      if (!isApplicationCode(applicationCode)) return { ok: false, message: "Choose a valid application." };
      const result = await api.request<{ connection: ApplicationConnectionTest }>(
        `/api/v1/hub/application-connections/${encodeURIComponent(applicationCode)}/test?storeId=${encodeURIComponent(storeId)}`
      );
      return { ok: true, connection: result.connection };
    }

    if (intent === "launch-application") {
      if (!hasHubPermission(hub, "store.read") && !canManage) return { ok: false, message: "Store read permission is required." };
      const applicationCode = textValue(form, "applicationCode", 16, true).toUpperCase();
      if (applicationCode !== "PLAY" && applicationCode !== "POS") {
        return { ok: false, message: "This application does not have a supported Hub callback yet." };
      }
      try {
        const result = await api.requestJson<HubApplicationLaunchResponse, { storeId: string }>(
          `/api/v1/hub/applications/${encodeURIComponent(applicationCode)}/launch`,
          {
            method: "POST",
            headers: requestCsrfHeaders(request),
            body: { storeId }
          }
        );
        return redirect(result.launch.url);
      } catch (error) {
        if (error instanceof ApiClientError) {
          const launchErrorCodes = [
            "APP_ASSIGNMENT_REQUIRED",
            "APP_ASSIGNMENT_SUSPENDED",
            "SCOPE_REQUIRED",
            "STORE_APPLICATION_DISABLED",
            "STORE_SCOPE_REQUIRED",
            "ENTITLEMENT_REQUIRED",
            "ENTITLEMENT_INACTIVE",
            "ENTITLEMENT_EXPIRED",
            "ENTITLEMENT_LIMIT_EXCEEDED",
            "APPLICATION_NOT_READY"
          ];
          if (launchErrorCodes.includes(error.code)) {
            logHubEvent("warn", "store.application.launch.denied", {
              store_id: storeId,
              application_code: applicationCode,
              error_code: error.code
            });
            return {
              ok: false,
              code: error.code,
              applicationCode,
              message: launchFailureMessage(error.code, applicationCode)
            };
          }
        }
        throw error;
      }
    }

    if (intent === "request-store-deletion") {
      if (!canDelete) return { ok: false, message: "Store deletion permission is required." };
      if (String(form.get("confirmDeletion") ?? "") !== "true") return { ok: false, message: "Confirm that you understand the retention window before scheduling deletion." };
      const reason = optionalTextValue(form, "deletionReason", 500) ?? "Store deletion requested by an organization administrator.";
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/deletion-request`,
        {
          method: "POST",
          headers: requestCsrfHeaders(request),
          body: { reason }
        }
      );
      return redirect(`${storePath(storeId, "settings")}&updated=deletion-requested`);
    }

    if (intent === "cancel-store-deletion") {
      if (!canDelete) return { ok: false, message: "Store deletion permission is required." };
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/deletion-request/cancel`,
        {
          method: "POST",
          headers: requestCsrfHeaders(request),
          body: {}
        }
      );
      return redirect(`${storePath(storeId, "settings")}&updated=deletion-cancelled`);
    }

    if (!canManage && !(canManageCatalog && (intent === "create-product" || intent === "update-product" || intent === "update-availability"))) {
      return { ok: false, message: "Store management permission is required for this action." };
    }

    if (intent === "update-store-application") {
      const applicationCode = textValue(form, "applicationCode", 16, true).toUpperCase();
      const enabledValue = textValue(form, "enabled", 5, true);
      if (!isStoreApplicationCode(applicationCode) || !["true", "false"].includes(enabledValue)) {
        return { ok: false, message: "Choose a valid application configuration." };
      }
      try {
        await api.requestJson(
          `/api/v1/hub/stores/${encodeURIComponent(storeId)}/applications/${encodeURIComponent(applicationCode)}`,
          {
            method: "PATCH",
            headers: requestCsrfHeaders(request),
            body: { enabled: enabledValue === "true" }
          }
        );
      } catch (error) {
        if (error instanceof ApiClientError && [
          "ENTITLEMENT_REQUIRED",
          "ENTITLEMENT_INACTIVE",
          "ENTITLEMENT_EXPIRED",
          "ENTITLEMENT_LIMIT_EXCEEDED"
        ].includes(error.code)) {
          return {
            ok: false,
            code: error.code,
            applicationCode,
            message: error.code === "ENTITLEMENT_LIMIT_EXCEEDED"
              ? `${applicationName(applicationCode)} cannot be enabled because the Free tier allows one application on one store. Disable the existing store app or review Applications & entitlements to upgrade.`
              : launchFailureMessage(error.code, applicationCode)
          };
        }
        throw error;
      }
      return redirect(`${storeAppsPath(storeId, applicationCode)}?updated=${enabledValue === "true" ? "enabled" : "disabled"}`);
    }

    if (intent === "update-application-config") {
      const applicationCode = textValue(form, "applicationCode", 16, true).toUpperCase();
      const schemaRef = textValue(form, "schemaRef", 64, true);
      const schemaVersion = textValue(form, "schemaVersion", 16, true);
      if (!isStoreApplicationCode(applicationCode)) return { ok: false, message: "Choose a valid store application." };
      const current = await api.request<{ configuration: HubStoreApplicationConfiguration }>(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/applications/${encodeURIComponent(applicationCode)}/config`
      );
      const schema = current.configuration.schemas.find((candidate) => candidate.schemaRef === schemaRef);
      if (!schema || schema.schemaVersion !== schemaVersion) return { ok: false, message: "The configuration schema is out of date. Reload the store workspace and try again." };
      const config = Object.fromEntries(schema.fields.map((field) => [field.key, configurationFieldValue(form, field)]));
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/applications/${encodeURIComponent(applicationCode)}/config`,
        {
          method: "PATCH",
          headers: requestCsrfHeaders(request),
          body: { schemaRef, schemaVersion, config }
        }
      );
      return redirect(`${storeAppsPath(storeId, applicationCode)}?updated=config`);
    }

    if (intent === "update-store") {
      const storeMode = textValue(form, "storeMode", 20, true);
      if (!isStoreMode(storeMode)) return { ok: false, message: "Choose a valid store mode." };
      const body: StoreSettingsBody = {
        name: textValue(form, "storeName", 160, true),
        code: textValue(form, "storeCode", 32, true).toUpperCase(),
        timezone: textValue(form, "storeTimezone", 64, true),
        currency: textValue(form, "storeCurrency", 8, true).toUpperCase(),
        storeMode,
        address: optionalTextValue(form, "storeAddress", 500) ?? "",
        phone: optionalTextValue(form, "storePhone", 50) ?? "",
        taxId: optionalTextValue(form, "storeTaxId", 50) ?? ""
      };
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}`,
        { method: "PATCH", headers: requestCsrfHeaders(request), body }
      );
      return redirect(`${storePath(storeId, "settings")}&updated=store`);
    }

    if (intent === "update-customer-profile") {
      const body = {
        publicSlug: publicSlugValue(textValue(form, "publicSlug", 63, true)),
        publicEnabled: String(form.get("publicEnabled") ?? "false") === "true",
        area: textValue(form, "area", 120, true),
        category: textValue(form, "category", 80, true),
        priceRange: textValue(form, "priceRange", 16, true),
        availabilityLabel: optionalTextValue(form, "availabilityLabel", 120) ?? null,
        description: optionalTextValue(form, "description", 1000) ?? null,
        imageUrl: optionalHttpUrl(optionalTextValue(form, "imageUrl", 2000)),
        mediaUrls: optionalLineList(form, "mediaUrls", 2000, 24).map((value) => optionalHttpUrl(value)).filter((value): value is string => value !== null),
        facilities: optionalLineList(form, "facilities", 120, 24),
        policySummary: optionalTextValue(form, "policySummary", 2000) ?? null,
        latitude: optionalNumberValue(form, "latitude", -90, 90),
        longitude: optionalNumberValue(form, "longitude", -180, 180),
        rating: optionalNumberValue(form, "rating", 0, 5),
        reviewCount: optionalIntegerValue(form, "reviewCount", 0, 2_000_000) ?? 0
      };
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/customer-profile`,
        { method: "PUT", headers: requestCsrfHeaders(request), body }
      );
      return redirect(`${storePath(storeId, "settings")}&updated=profile`);
    }

    if (intent === "create-product") {
      const basePriceMinor = Number(textValue(form, "basePriceMinor", 12, true));
      if (!Number.isInteger(basePriceMinor) || basePriceMinor < 0) return { ok: false, message: "Enter a valid product price in minor currency units." };
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/catalog/products`,
        {
          method: "POST",
          headers: requestCsrfHeaders(request),
          body: {
            sku: textValue(form, "productSku", 64, true).toUpperCase(),
            name: textValue(form, "productName", 160, true),
            description: optionalTextValue(form, "productDescription", 2000) ?? "",
            basePriceMinor,
            currency: textValue(form, "productCurrency", 3, true).toUpperCase(),
            categoryId: optionalTextValue(form, "productCategoryId", 64),
            imageUrl: optionalHttpUrl(optionalTextValue(form, "productImageUrl", 2000)),
            displayOrder: optionalIntegerValue(form, "productDisplayOrder", 0, 999999) ?? 0
          }
        }
      );
      return redirect(`${storePath(storeId, "catalog")}&updated=product`);
    }

    if (intent === "update-product") {
      const productId = textValue(form, "productId", 64, true);
      const body: Record<string, unknown> = {
        name: textValue(form, "productName", 160, true),
        description: optionalTextValue(form, "productDescription", 2000) ?? "",
        basePriceMinor: optionalIntegerValue(form, "basePriceMinor", 0, 2147483647),
        currency: textValue(form, "productCurrency", 3, true).toUpperCase(),
        categoryId: optionalTextValue(form, "productCategoryId", 64) ?? null,
        imageUrl: optionalHttpUrl(optionalTextValue(form, "productImageUrl", 2000)),
        displayOrder: optionalIntegerValue(form, "productDisplayOrder", 0, 999999) ?? 0,
        status: textValue(form, "productStatus", 16, true).toUpperCase()
      };
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/catalog/products/${encodeURIComponent(productId)}`,
        { method: "PATCH", headers: requestCsrfHeaders(request), body }
      );
      return redirect(`${storePath(storeId, "catalog")}&updated=product`);
    }

    if (intent === "update-availability") {
      const channel = textValue(form, "channel", 16, true).toUpperCase();
      const productId = textValue(form, "productId", 64, true);
      if (!isCatalogChannel(channel)) return { ok: false, message: "Choose a valid catalog channel." };
      const priceOverrideMinor = optionalIntegerValue(form, "priceOverrideMinor", 0, 2147483647);
      const availabilityBody: Record<string, unknown> = {
        channel,
        isAvailable: String(form.get("isAvailable") ?? "false") === "true",
        soldOut: String(form.get("soldOut") ?? "false") === "true"
      };
      if (String(form.get("priceOverrideMinor") ?? "").trim()) availabilityBody.priceOverrideMinor = priceOverrideMinor;
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/catalog/products/${encodeURIComponent(productId)}/availability`,
        {
          method: "PATCH",
          headers: requestCsrfHeaders(request),
          body: availabilityBody
        }
      );
      return redirect(`${storePath(storeId, "catalog")}&updated=availability`);
    }

    if (intent === "create-template") {
      const result = await api.requestJson<{ template: { id: string } }>(
        "/api/v1/hub/store-templates",
        {
          method: "POST",
          headers: requestCsrfHeaders(request),
          body: {
            name: textValue(form, "templateName", 120, true),
            sourceStoreId: storeId
          }
        }
      );
      return redirect(`${storePath(storeId, "settings")}&updated=template&template=${encodeURIComponent(result.template.id)}`);
    }

    if (intent === "duplicate-store") {
      const duplicatePublicSlug = optionalTextValue(form, "duplicatePublicSlug", 63);
      const duplicateCode = textValue(form, "duplicateCode", 32, true).toUpperCase();
      const result = await api.requestJson<{ store: StoreSummary }>(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/duplicate`,
        {
          method: "POST",
          headers: requestCsrfHeaders(request),
          body: {
            name: textValue(form, "duplicateName", 160, true),
            code: duplicateCode,
            publicSlug: publicSlugValue(duplicatePublicSlug ?? defaultPublicSlug(duplicateCode))
          }
        }
      );
      return redirect(`${storePath(result.store.id)}?created=duplicate`);
    }

    return { ok: false, message: "Unknown store action." };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : "The store action could not be completed." };
  }
}

function StoreNotFound() {
  return (
    <main className="aevo-error-page">
      <PermissionDeniedState
        title="Store not found"
        description="This store is inactive, unavailable to your membership, or no longer exists in the organization."
        action={<Link className="aevo-button aevo-button--secondary" to="/stores">Back to Stores & branches</Link>}
      />
    </main>
  );
}

function ActionLink({
  to,
  variant = "secondary",
  children,
  className = ""
}: {
  to: string;
  variant?: "primary" | "secondary" | "ghost";
  children: ReactNode;
  className?: string;
}) {
  const navigation = useNavigation();
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    if (navigation.state === "idle") setClicked(false);
  }, [navigation.state]);
  const isBusy = clicked && navigation.state !== "idle";
  return (
    <Link
      to={to}
      prefetch="intent"
      className={`aevo-button aevo-button--${variant} ${isBusy ? "is-busy" : ""} ${className}`.trim()}
      aria-busy={isBusy || undefined}
      onClick={() => setClicked(true)}
    >
      {isBusy ? <span className="aevo-button__busy" aria-hidden="true" /> : null}
      <span>{children}</span>
    </Link>
  );
}

function ModuleCardLink({
  to,
  code,
  label,
  description
}: {
  to: string;
  code: string;
  label: string;
  description: string;
}) {
  const navigation = useNavigation();
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    if (navigation.state === "idle") setClicked(false);
  }, [navigation.state]);
  const isBusy = clicked && navigation.state !== "idle";
  return (
    <Link
      to={to}
      prefetch="intent"
      className={`aevo-module-card ${isBusy ? "is-pending" : ""}`.trim()}
      aria-busy={isBusy || undefined}
      onClick={() => setClicked(true)}
    >
      <div className="aevo-module-card__header">
        <span className="aevo-eyebrow">{code}</span>
        {isBusy ? <span className="aevo-card-spinner" aria-hidden="true" /> : null}
      </div>
      <strong>{label}</strong>
      <span>{description}</span>
    </Link>
  );
}

function StoreScopeBanner({ storeName, storeCode }: { storeName: string; storeCode: string }) {
  return (
    <section className="aevo-scope-banner aevo-scope-banner--store" aria-label={`${storeName} store scope`}>
      <div className="aevo-scope-banner__content">
        <span className="aevo-scope-banner__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10.5 12 4l9 6.5V20H3v-9.5ZM8 20v-5h8v5M7 10h.01M12 10h.01M17 10h.01" />
          </svg>
        </span>
        <div>
          <span className="aevo-eyebrow">Store workspace context</span>
          <p>
            You are managing <strong>{storeName}</strong> ({storeCode}). Configurations and application bindings on this page apply only to this branch. Organization defaults remain isolated.
          </p>
        </div>
      </div>
      <StatusBadge tone="success">{storeCode} · Store scope</StatusBadge>
    </section>
  );
}

function StoreTabs({ storeId, active }: { storeId: string; active: StoreView }) {
  const navigation = useNavigation();
  const [pendingView, setPendingView] = useState<StoreView | null>(null);

  useEffect(() => {
    if (navigation.state === "idle") {
      setPendingView(null);
    }
  }, [navigation.state]);

  const tabs: Array<[StoreView, string]> = [
    ["overview", "Overview"],
    ["settings", "Store settings"],
    ["apps", "Apps & features"],
    ["catalog", "Products & catalog"]
  ];

  return (
    <nav className="aevo-store-workspace-tabs" aria-label="Store workspace sections">
      {tabs.map(([view, label]) => {
        const isPending = pendingView === view && navigation.state !== "idle";
        const isActive = active === view;
        return (
          <Link
            className={`${isActive ? "is-active" : ""} ${isPending ? "is-pending" : ""}`.trim()}
            key={view}
            to={storePath(storeId, view)}
            prefetch="intent"
            aria-current={isActive ? "page" : undefined}
            aria-busy={isPending || undefined}
            onClick={() => {
              if (view !== active) setPendingView(view);
            }}
          >
            <span>{label}</span>
            {isPending ? <span className="aevo-tab-spinner" aria-hidden="true" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function formatDeletionCountdown(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${hours.toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

function StoreDeletionLifecycle({ deletion, canDelete, busy }: { deletion: StoreDeletionRequest | null; canDelete: boolean; busy: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = (): void => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [deletion?.id]);

  if (deletion?.status === "PENDING") {
    const secondsRemaining = now === null
      ? null
      : Math.max(0, Math.floor((Date.parse(deletion.scheduledPurgeAt) - now) / 1_000));
    return (
      <section className="aevo-settings-section aevo-retention-section is-pending" aria-labelledby="deletion-heading">
        <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Retention &amp; recovery</span><h2 id="deletion-heading">Deletion is scheduled</h2><p>This store is inactive while its data remains recoverable. No purge happens before the retention deadline.</p></div><StatusBadge tone="warning">Pending deletion</StatusBadge></div>
        <div className="aevo-retention-countdown" role="status" aria-live="polite"><span>Time remaining</span><strong>{secondsRemaining === null ? "Calculating…" : secondsRemaining === 0 ? "Due for worker review" : formatDeletionCountdown(secondsRemaining)}</strong><time dateTime={deletion.scheduledPurgeAt}>Scheduled for {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(Date.parse(deletion.scheduledPurgeAt))}</time></div>
        <p className="aevo-form-hint">The retention worker must process the request after the deadline. Audit records are retained independently for accountability.</p>
        {canDelete ? <Form method="post" className="aevo-form-actions"><input type="hidden" name="intent" value="cancel-store-deletion" /><Button variant="secondary" type="submit" busy={busy} busyLabel="Restoring store…">Cancel and restore store</Button></Form> : <p className="aevo-form-hint">Store deletion permission is required to cancel this request.</p>}
      </section>
    );
  }

  return (
    <section className="aevo-settings-section aevo-retention-section is-danger" aria-labelledby="deletion-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Retention &amp; recovery</span><h2 id="deletion-heading">Schedule store deletion</h2><p>Deletion is never immediate. Core records the request, deactivates the store, and opens a seven-day recovery window before a retention worker may purge data.</p></div><StatusBadge tone="neutral">Recoverable</StatusBadge></div>
      {canDelete ? <Form method="post" className="aevo-retention-form">
        <input type="hidden" name="intent" value="request-store-deletion" />
        <label>Reason<Input name="deletionReason" maxLength={500} defaultValue="Store is no longer in operation." required /></label>
        <label className="aevo-danger-confirm"><input type="checkbox" name="confirmDeletion" value="true" required />I understand this starts a retention countdown and the store will be inactive.</label>
        <Button variant="secondary" type="submit" busy={busy} busyLabel="Scheduling deletion…">Schedule deletion</Button>
      </Form> : <p className="aevo-form-hint">Store deletion permission is required for this action.</p>}
    </section>
  );
}

function StoreSettings({ data, busy }: { data: StoreLoaderData; busy: boolean }) {
  const store = data.store;
  const profile = data.profile;
  if (!store) return null;
  const canManage = hasHubPermission(data.hub, "store.manage") || hasHubPermission(data.hub, "organization.manage");
  const canDelete = hasHubPermission(data.hub, "store.delete") || hasHubPermission(data.hub, "organization.manage");
  const deletionPending = data.deletion?.status === "PENDING";
  const canEdit = canManage && !deletionPending;
  return <>
    <section className="aevo-settings-section" aria-labelledby="store-settings-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Store configuration</span><h2 id="store-settings-heading">Store identity & operations</h2><p>These values are stored against this branch and checked by Core API authorization.</p></div></div>
      <Form method="post" className="aevo-form-grid">
        <input type="hidden" name="intent" value="update-store" />
        <label>Store name<Input name="storeName" defaultValue={store.name} maxLength={160} required disabled={!canEdit} /></label>
        <label>Code<Input name="storeCode" defaultValue={store.code} maxLength={32} required disabled={!canEdit} /></label>
        <label>Mode<Select name="storeMode" defaultValue={store.storeMode ?? "POS"} disabled={!canEdit}>{storeModes.map((mode) => <option key={mode}>{mode}</option>)}</Select></label>
        <label>Timezone<Input name="storeTimezone" defaultValue={store.timezone} maxLength={64} required disabled={!canEdit} /></label>
        <label>Currency<Input name="storeCurrency" defaultValue={store.currency ?? "THB"} maxLength={8} required disabled={!canEdit} /></label>
        <label>Phone<Input name="storePhone" defaultValue={store.phone ?? ""} maxLength={50} disabled={!canEdit} /></label>
        <label className="aevo-field--wide">Address<Input name="storeAddress" defaultValue={store.address ?? ""} maxLength={500} disabled={!canEdit} /></label>
        <label>Tax ID<Input name="storeTaxId" defaultValue={store.taxId ?? ""} maxLength={50} disabled={!canEdit} /></label>
        <div className="aevo-form-actions aevo-field--wide">{canEdit ? <Button variant="primary" type="submit" busy={busy} busyLabel="Saving store…">Save store settings</Button> : <span className="aevo-form-hint">{deletionPending ? "Store editing is paused during the retention window." : "Store management permission is required."}</span>}</div>
      </Form>
    </section>
    <section className="aevo-settings-section" aria-labelledby="public-profile-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Customer App projection</span><h2 id="public-profile-heading">Public store profile</h2><p>Only the fields below are published to the customer-facing discovery surface.</p></div></div>
      <Form method="post" className="aevo-form-grid">
        <input type="hidden" name="intent" value="update-customer-profile" />
        <label>Public slug<Input name="publicSlug" defaultValue={profile?.publicSlug ?? store.code.toLowerCase()} maxLength={63} required disabled={!canEdit} /></label>
        <label>Area<Input name="area" defaultValue={profile?.area ?? ""} maxLength={120} required disabled={!canEdit} /></label>
        <label>Category<Input name="category" defaultValue={profile?.category ?? ""} maxLength={80} required disabled={!canEdit} /></label>
        <label>Price range<Input name="priceRange" defaultValue={profile?.priceRange ?? "฿฿"} maxLength={16} required disabled={!canEdit} /></label>
        <label>Availability label<Input name="availabilityLabel" defaultValue={profile?.availabilityLabel ?? ""} maxLength={120} disabled={!canEdit} /></label>
        <label>Hero image URL<Input name="imageUrl" type="url" defaultValue={profile?.imageUrl ?? ""} maxLength={2000} disabled={!canEdit} /></label>
        <label>Latitude<Input name="latitude" type="number" step="any" min={-90} max={90} defaultValue={profile?.latitude ?? ""} disabled={!canEdit} /></label>
        <label>Longitude<Input name="longitude" type="number" step="any" min={-180} max={180} defaultValue={profile?.longitude ?? ""} disabled={!canEdit} /></label>
        <label>Rating<Input name="rating" type="number" step="0.01" min={0} max={5} defaultValue={profile?.rating ?? ""} disabled={!canEdit} /></label>
        <label>Review count<Input name="reviewCount" type="number" min={0} defaultValue={profile?.reviewCount ?? 0} disabled={!canEdit} /></label>
        <label className="aevo-field--wide">Description<textarea name="description" defaultValue={profile?.description ?? ""} maxLength={1000} disabled={!canEdit} /></label>
        <label className="aevo-field--wide">Gallery URLs<textarea name="mediaUrls" maxLength={24 * 2000} placeholder="One URL per line" defaultValue={profile?.mediaUrls.join("\n") ?? ""} disabled={!canEdit} /></label>
        <label className="aevo-field--wide">Facilities<textarea name="facilities" maxLength={24 * 120} placeholder="Wi-Fi, Parking" defaultValue={profile?.facilities.join(", ") ?? ""} disabled={!canEdit} /></label>
        <label className="aevo-field--wide">Policy summary<textarea name="policySummary" maxLength={2000} defaultValue={profile?.policySummary ?? ""} disabled={!canEdit} /></label>
        <label className="aevo-choice"><input type="checkbox" name="publicEnabled" value="true" defaultChecked={profile?.publicEnabled === true} disabled={!canEdit} /> Publish this profile to Aevo Go</label>
        <div className="aevo-form-actions aevo-field--wide">{canEdit ? <Button variant="secondary" type="submit" busy={busy} busyLabel="Saving profile…">Save Aevo Go profile</Button> : <span className="aevo-form-hint">{deletionPending ? "Store editing is paused during the retention window." : "Store management permission is required."}</span>}</div>
      </Form>
    </section>
    <section className="aevo-settings-section" aria-labelledby="reuse-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Branch acceleration</span><h2 id="reuse-heading">Reuse this configuration</h2><p>Save the current store as a reusable template or duplicate it for another branch. Products and menu availability are copied by SKU.</p></div></div>
      <div className="aevo-reuse-grid">
        <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="create-template" /><h3>Save as template</h3><label>Template name<Input name="templateName" maxLength={120} required disabled={!canEdit} /></label><Button variant="secondary" type="submit" busy={busy} busyLabel="Saving template…" disabled={!canEdit}>Save template</Button></Form>
        <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="duplicate-store" /><h3>Duplicate this store</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>New store name<Input name="duplicateName" maxLength={160} required disabled={!canEdit} /></label><label>New code<Input name="duplicateCode" maxLength={32} required disabled={!canEdit} /></label><label>Public slug<Input name="duplicatePublicSlug" maxLength={63} disabled={!canEdit} /></label></div><Button variant="primary" type="submit" busy={busy} busyLabel="Duplicating store…" disabled={!canEdit}>Create branch from store</Button></Form>
      </div>
    </section>
    <StoreDeletionLifecycle deletion={data.deletion} canDelete={canDelete} busy={busy} />
  </>;
}

function launchRecoveryLink(
  result: Extract<StoreActionResult, { ok: false }>,
  storeId: string
): { to: string; label: string } | undefined {
  if (!result.code) return undefined;
  if (["ENTITLEMENT_REQUIRED", "ENTITLEMENT_INACTIVE", "ENTITLEMENT_EXPIRED", "ENTITLEMENT_LIMIT_EXCEEDED"].includes(result.code)) {
    return { to: "/settings#billing-heading", label: "Review entitlements" };
  }
  if (["APPLICATION_NOT_READY", "STORE_APPLICATION_DISABLED"].includes(result.code) && result.applicationCode) {
    return { to: storeAppsPath(storeId, result.applicationCode), label: "Review app settings" };
  }
  if (["APP_ASSIGNMENT_REQUIRED", "APP_ASSIGNMENT_SUSPENDED", "SCOPE_REQUIRED", "STORE_SCOPE_REQUIRED"].includes(result.code)) {
    return { to: "/settings#team-heading", label: "Open Team & access" };
  }
  return undefined;
}

function AppsWorkspace({ data, busy, connection }: { data: StoreLoaderData; busy: boolean; connection?: ApplicationConnectionTest }) {
  const canManage = hasHubPermission(data.hub, "store.manage") || hasHubPermission(data.hub, "organization.manage");
  const navigation = useNavigation();
  const pendingApplication = navigation.formData?.get("applicationCode");
  const pendingIntent = String(navigation.formData?.get("intent") ?? "");
  const enabledApplicationCount = data.applications.filter((application) => application.status === "ACTIVE" && application.applicationActive).length;
  return <section className="aevo-settings-section" aria-labelledby="store-apps-heading">
    <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Store-level access boundary</span><h2 id="store-apps-heading">Apps &amp; features for this store</h2><p>Enable only the applications this store needs. Select an enabled app to open its dedicated page with status, capabilities, and important store details.</p></div><span className="aevo-count-badge">{enabledApplicationCount} enabled</span></div>
    <div className="aevo-store-app-summary" aria-live="polite">
      <div className="aevo-store-app-summary__metric"><strong>{enabledApplicationCount}</strong><span>enabled here</span></div>
      <div className="aevo-store-app-summary__metric"><strong>{data.applications.length}</strong><span>available to the organization</span></div>
      <p>Each enabled app has its own workspace page. Configuration is available there without opening a modal over this access directory.</p>
    </div>
    <div className="aevo-store-app-grid">
      {data.applications.map((application) => {
        const enabled = application.status === "ACTIVE" && application.applicationActive;
        const applicationBusy = busy && String(pendingApplication ?? "") === application.applicationCode;
        const savingApplication = applicationBusy && pendingIntent === "update-store-application";
        const launchingApplication = applicationBusy && pendingIntent === "launch-application";
        const testingForApplication = busy && String(pendingApplication ?? "") === application.applicationCode && pendingIntent === "test-application";
        const test = connection?.application === application.applicationCode ? connection : undefined;
        return <article id={`store-app-${application.applicationCode.toLowerCase()}`} className={`aevo-store-app-card${enabled ? " is-enabled" : ""}`} key={application.applicationCode} aria-labelledby={`store-app-${application.applicationCode.toLowerCase()}-heading`}>
          <div className="aevo-store-app-card__top"><div className="aevo-store-app-card__identity"><span className="aevo-app-icon" aria-hidden="true">{application.applicationCode.slice(0, 2)}</span><div><h3 id={`store-app-${application.applicationCode.toLowerCase()}-heading`}>{application.applicationName}</h3><p>{application.applicationCode} is {enabled ? "available" : "not available"} at {data.store?.name}.</p></div></div><span className={enabled ? "aevo-status aevo-status--success" : "aevo-status aevo-status--neutral"}>{enabled ? "Enabled" : application.applicationActive ? "Disabled" : "Registry disabled"}</span></div>
          <div className="aevo-feature-list">{applicationFeatures(application).map((feature) => <div className="aevo-feature-row" key={feature.label}><div><strong>{feature.label}</strong><small>{feature.description}</small></div>{enabled && feature.href ? <Link className="aevo-button aevo-button--secondary aevo-button--small" to={storePath(data.store?.id ?? "", feature.href)}>Open</Link> : null}</div>)}</div>
          <div className="aevo-store-app-card__actions">
            {canManage ? <Form method="post" aria-busy={applicationBusy}><input type="hidden" name="intent" value="update-store-application" /><input type="hidden" name="applicationCode" value={application.applicationCode} /><input type="hidden" name="enabled" value={enabled ? "false" : "true"} /><Button variant={enabled ? "secondary" : "primary"} type="submit" busy={savingApplication} busyLabel="Saving…" disabled={!application.applicationActive}>{enabled ? "Disable at this store" : "Enable at this store"}</Button></Form> : <span className="aevo-form-hint">Store management permission is required.</span>}
            {enabled ? <Link className="aevo-button aevo-button--secondary" to={storeAppsPath(data.store?.id ?? "", application.applicationCode)} prefetch="intent">View app</Link> : null}
            {enabled && (application.applicationCode === "PLAY" || application.applicationCode === "POS") ? <Form method="post" className="aevo-app-launch-form" aria-busy={applicationBusy}><input type="hidden" name="intent" value="launch-application" /><input type="hidden" name="applicationCode" value={application.applicationCode} /><Button variant="secondary" type="submit" busy={launchingApplication} busyLabel="Checking app…">Open full app · {application.applicationName}</Button></Form> : enabled && (application.applicationCode === "KIOSK" || application.applicationCode === "QUEUE") ? <span className="aevo-form-hint">Callback is not available for this application yet.</span> : null}
            <Form method="post" className="aevo-connection-test-form"><input type="hidden" name="intent" value="test-application" /><input type="hidden" name="applicationCode" value={application.applicationCode} /><Button variant="ghost" type="submit" busy={testingForApplication} busyLabel="Testing…">Test connection</Button></Form>
          </div>
          {test ? <p className={`aevo-connection-result is-${test.status.toLowerCase()}`} role="status">{test.status === "ONLINE" ? `Online · ${test.latencyMs}ms` : test.status === "NOT_CONFIGURED" ? "URL not configured" : `${test.status.replace("_", " ")} · ${test.latencyMs}ms`} · access {test.access.reason.toLowerCase().replaceAll("_", " ")}</p> : null}
        </article>;
      })}
    </div>
  </section>;
}

function CatalogWorkspace({ data, busy }: { data: StoreLoaderData; busy: boolean }) {
  const catalog = data.catalog;
  const canManage = hasHubPermission(data.hub, "catalog.manage") || hasHubPermission(data.hub, "store.manage") || hasHubPermission(data.hub, "organization.manage");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "ARCHIVED">("ACTIVE");
  const [channelFilter, setChannelFilter] = useState<"ALL" | (typeof catalogChannels)[number]>("ALL");
  const [dialogMode, setDialogMode] = useState<"create" | "edit" | null>(null);
  const [editingProduct, setEditingProduct] = useState<ProductSummary | null>(null);
  if (data.catalogError || !catalog) return <section className="aevo-settings-section"><PermissionDeniedState title="Catalog is not enabled" description={data.catalogError ?? "Enable POS or Kiosk for this store before opening Products & catalog."} action={<Link className="aevo-button aevo-button--secondary" to={storePath(data.store?.id ?? "", "apps")}>Configure apps</Link>} /></section>;
  const normalizedQuery = query.trim().toLowerCase();
  const products = catalog.products.filter((product) => {
    if (statusFilter !== "ALL" && product.status !== statusFilter) return false;
    if (normalizedQuery && !`${product.name} ${product.sku} ${product.description}`.toLowerCase().includes(normalizedQuery)) return false;
    if (channelFilter !== "ALL" && !product.availability.some((item) => item.channel === channelFilter && item.isAvailable)) return false;
    return true;
  });
  const activeProducts = catalog.products.filter((product) => product.status === "ACTIVE").length;
  const configuredChannels = new Set(catalog.products.flatMap((product) => product.availability.filter((item) => item.isAvailable).map((item) => item.channel))).size;
  const closeDialog = () => {
    setDialogMode(null);
    setEditingProduct(null);
  };
  const openCreate = () => {
    setEditingProduct(null);
    setDialogMode("create");
  };
  const openEdit = (product: ProductSummary) => {
    setEditingProduct(product);
    setDialogMode("edit");
  };
  return <>
    <section className="aevo-settings-section" aria-labelledby="catalog-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">POS / Kiosk feature</span><h2 id="catalog-heading">Products &amp; catalog</h2><p>Product identity lives at organization level. Availability and selling details below are scoped to <strong>{data.store?.name}</strong>.</p></div><span className="aevo-count-badge">{activeProducts} active · {catalog.products.length} total</span></div>
      <div className="aevo-catalog-summary" aria-label="Catalog summary"><div><strong>{activeProducts}</strong><span>Active products</span></div><div><strong>{catalog.categories.length}</strong><span>Categories</span></div><div><strong>{configuredChannels}</strong><span>Channels in use</span></div><div><strong>{catalog.menus.length}</strong><span>Store menus</span></div></div>
      <div className="aevo-catalog-toolbar"><label className="aevo-catalog-search"><span>Search products</span><Input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Name, SKU, or description" /></label><label><span>Status</span><Select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as typeof statusFilter)}><option value="ACTIVE">Active</option><option value="ALL">All statuses</option><option value="ARCHIVED">Archived</option></Select></label><label><span>Store channel</span><Select value={channelFilter} onChange={(event) => setChannelFilter(event.currentTarget.value as typeof channelFilter)}><option value="ALL">All channels</option>{catalogChannels.map((channel) => <option key={channel} value={channel}>{channel}</option>)}</Select></label>{canManage ? <Button variant="primary" type="button" onClick={openCreate}>Add product</Button> : null}</div>
      {products.length === 0 ? <div className="aevo-catalog-empty" role="status"><strong>{catalog.products.length === 0 ? "Start your catalog" : "No products match these filters"}</strong><span>{catalog.products.length === 0 ? "Add the organization product once, then configure which channels this store can sell it through." : "Try another search or reset the filters."}</span>{canManage && catalog.products.length === 0 ? <Button variant="secondary" type="button" onClick={openCreate}>Add first product</Button> : null}</div> : <div className="aevo-table-wrap aevo-catalog-table-wrap"><table className="aevo-data-table aevo-catalog-table"><thead><tr><th>Product</th><th>Category</th><th>Base price</th><th>Store channels</th><th><span className="aevo-sr-only">Actions</span></th></tr></thead><tbody>{products.map((product) => { const category = catalog.categories.find((item) => item.id === product.categoryId); return <tr key={product.id}><td><div className="aevo-catalog-product"><span className="aevo-catalog-product__media">{product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : <span aria-hidden="true">{product.name.slice(0, 1).toUpperCase()}</span>}</span><span><strong>{product.name}</strong><small><code>{product.sku}</code>{product.description ? ` · ${product.description}` : ""}</small></span></div></td><td>{category?.name ?? <span className="aevo-form-hint">Uncategorized</span>}</td><td><strong>{(product.basePriceMinor / 100).toFixed(2)} {product.currency}</strong><small>{product.variants.length > 1 ? `${product.variants.length} variants` : "Standard price"}</small></td><td><div className="aevo-catalog-channels" aria-label={`Channels for ${product.name}`}>{catalogChannels.map((channel) => { const availability = product.availability.find((item) => item.channel === channel); const enabled = availability?.isAvailable === true; return canManage ? <Form method="post" className="aevo-catalog-channel-form" key={channel}><input type="hidden" name="intent" value="update-availability" /><input type="hidden" name="productId" value={product.id} /><input type="hidden" name="channel" value={channel} /><input type="hidden" name="isAvailable" value={String(!enabled)} /><input type="hidden" name="soldOut" value={String(availability?.soldOut ?? false)} /><Button variant="secondary" type="submit" busy={busy} busyLabel="Saving…" className={enabled ? "is-enabled" : ""} aria-label={`${enabled ? "Disable" : "Enable"} ${channel} for ${product.name}`}>{channel}<span>{enabled ? "On" : "Off"}</span></Button></Form> : <span className={`aevo-catalog-channel ${enabled ? "is-enabled" : ""}`} key={channel}>{channel}<span>{enabled ? "On" : "Off"}</span></span>; })}</div></td><td>{canManage ? <Button variant="secondary" type="button" onClick={() => openEdit(product)}>Edit</Button> : <span className="aevo-form-hint">Read only</span>}</td></tr>; })}</tbody></table></div>}
    </section>
    <section className="aevo-settings-section" aria-labelledby="catalog-summary-heading"><div className="aevo-section-heading"><div><span className="aevo-eyebrow">Catalog structure</span><h2 id="catalog-summary-heading">Categories, menus &amp; modifiers</h2><p>These organization and store structures are shared with POS. Product display order and image are included in the same catalog response.</p></div></div><dl className="aevo-store-facts"><div><dt>Categories</dt><dd>{catalog.categories.length}</dd></div><div><dt>Menus</dt><dd>{catalog.menus.length}</dd></div><div><dt>Modifier groups</dt><dd>{catalog.modifierGroups.length}</dd></div><div><dt>Store menus</dt><dd>{catalog.menus.filter((menu) => menu.storeId === data.store?.id).length}</dd></div></dl></section>
    {canManage ? <Dialog open={dialogMode !== null} title={dialogMode === "edit" ? `Edit ${editingProduct?.name ?? "product"}` : "Add product"} description="Product details are shared with POS and other enabled applications. Store channel availability remains local to this store." onClose={closeDialog}>
      <Form key={`${dialogMode}-${editingProduct?.id ?? "new"}`} method="post" className="aevo-catalog-product-form"><input type="hidden" name="intent" value={dialogMode === "edit" ? "update-product" : "create-product"} />{editingProduct ? <input type="hidden" name="productId" value={editingProduct.id} /> : null}<div className="aevo-form-grid aevo-form-grid--compact"><label>Product name<Input name="productName" defaultValue={editingProduct?.name ?? ""} maxLength={160} required autoFocus /></label><label>SKU<Input name="productSku" defaultValue={editingProduct?.sku ?? ""} maxLength={64} required disabled={dialogMode === "edit"} /></label><label>Base price, minor units<Input name="basePriceMinor" type="number" inputMode="numeric" min={0} max={2147483647} defaultValue={editingProduct?.basePriceMinor ?? 0} required /></label><label>Currency<Input name="productCurrency" defaultValue={editingProduct?.currency ?? data.store?.currency ?? "THB"} maxLength={3} required /></label><label>Category<Select name="productCategoryId" defaultValue={editingProduct?.categoryId ?? ""}><option value="">Uncategorized</option>{catalog.categories.filter((category) => category.status === "ACTIVE").map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</Select></label><label>Display order<Input name="productDisplayOrder" type="number" inputMode="numeric" min={0} max={999999} defaultValue={editingProduct?.displayOrder ?? 0} /></label><label className="aevo-field--wide">Image URL <span className="aevo-form-hint">Optional</span><Input name="productImageUrl" type="url" defaultValue={editingProduct?.imageUrl ?? ""} maxLength={2000} placeholder="https://…" /></label><label className="aevo-field--wide">Description<Input name="productDescription" defaultValue={editingProduct?.description ?? ""} maxLength={2000} /></label>{editingProduct ? <label>Status<Select name="productStatus" defaultValue={editingProduct.status}><option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option></Select></label> : null}</div><div className="aevo-catalog-form-note"><strong>Shared catalog data</strong><span>POS will receive the name, SKU, price, description, image, order, variants, and channel availability from Core.</span></div><div className="aevo-dialog-actions"><Button variant="secondary" type="button" onClick={closeDialog}>Cancel</Button><Button variant="primary" type="submit" busy={busy} busyLabel={dialogMode === "edit" ? "Saving product…" : "Creating product…"}>{dialogMode === "edit" ? "Save product" : "Create product"}</Button></div></Form>
    </Dialog> : null}
  </>;
}

export default function StoreRoute() {
  const data = useLoaderData() as StoreLoaderData;
  const actionData = useActionData() as StoreActionResult | undefined;
  const navigation = useNavigation();
  const location = useLocation();
  const store = data.store;
  if (data.permissionDenied) return <main className="aevo-error-page"><PermissionDeniedState title="Store access is restricted" description="The server resolved your Hub session, but this store requires store.read or a higher organization permission." action={<Link className="aevo-button aevo-button--secondary" to="/stores">Back to Stores & branches</Link>} /></main>;
  if (!store) return <StoreNotFound />;
  const busy = navigation.state !== "idle";
  const canManage = hasHubPermission(data.hub, "store.manage") || hasHubPermission(data.hub, "organization.manage");
  const updated = new URLSearchParams(location.search).get("updated");
  const created = new URLSearchParams(location.search).get("created");
  const connection = actionData?.ok === true ? actionData.connection : undefined;
  const recovery = actionData?.ok === false ? launchRecoveryLink(actionData, store.id) : undefined;

  const enabledModules = data.applications
    .filter((application) => application.status === "ACTIVE" && application.applicationActive)
    .flatMap((application) =>
      applicationFeatures(application)
        .filter((feature) => feature.href !== undefined)
        .map((feature) => ({
          key: `${application.applicationCode}-${feature.label}`,
          to: storePath(store.id, feature.href),
          code: application.applicationCode,
          label: feature.label,
          description: feature.description
        }))
    );

  return <>
    <Breadcrumbs className="aevo-page-breadcrumb" items={[{ label: "Hub", href: "/" }, { label: "Stores & branches", href: "/stores" }, { label: store.name }]} />
    <section className="aevo-page-heading">
      <div>
        <div className="aevo-page-heading__title-row">
          <h1>{store.name}</h1>
          <StatusBadge tone={store.status === "ACTIVE" ? "success" : "warning"}>{store.status ?? "ACTIVE"}</StatusBadge>
        </div>
        <p className="aevo-page-heading__meta">
          <code>{store.code}</code>
          <span>·</span>
          <span>{store.timezone}</span>
          <span>·</span>
          <span>{store.currency ?? "THB"}</span>
        </p>
      </div>
      <div className="aevo-page-heading__actions">
        <ActionLink to="/stores">All stores</ActionLink>
        <ActionLink to="/settings">Organization settings</ActionLink>
      </div>
    </section>
    <StoreScopeBanner storeName={store.name} storeCode={store.code} />
    <StoreTabs storeId={store.id} active={data.view} />
    {actionData?.ok === false ? <div className="aevo-inline-alert aevo-inline-alert--error" role="alert"><span>{actionData.message}</span>{recovery ? <Link className="aevo-button aevo-button--secondary aevo-button--small" to={recovery.to}>{recovery.label}</Link> : null}</div> : updated ? <div className="aevo-inline-alert" role="status">Saved {updated} successfully.</div> : created ? <div className="aevo-inline-alert" role="status">Store created from this configuration.</div> : null}
    {busy ? <div className="aevo-loading-strip" role="status">Loading store workspace…</div> : null}
    {data.view === "overview" ? <>
      <section className="aevo-settings-section aevo-store-summary" aria-labelledby="store-summary-heading">
        <div className="aevo-section-heading">
          <div>
            <span className="aevo-eyebrow">Branch overview</span>
            <h2 id="store-summary-heading">Operational summary</h2>
            <p>{store.address || "No address has been added yet."}{store.phone ? ` · ${store.phone}` : ""}</p>
          </div>
          <span className="aevo-count-badge">{data.applications.filter((application) => application.status === "ACTIVE" && application.applicationActive).length} apps enabled</span>
        </div>
        <dl className="aevo-store-facts">
          <div><dt>Store code</dt><dd><code>{store.code}</code></dd></div>
          <div><dt>Operating mode</dt><dd>{store.storeMode ?? "—"}</dd></div>
          <div><dt>Currency</dt><dd>{store.currency ?? "THB"}</dd></div>
          <div><dt>Public profile</dt><dd>{data.profile?.publicEnabled ? "Published" : "Not published"}</dd></div>
        </dl>
      </section>
      <section className="aevo-settings-section" aria-labelledby="workspace-features-heading">
        <div className="aevo-section-heading">
          <div>
            <span className="aevo-eyebrow">Enabled surfaces</span>
            <h2 id="workspace-features-heading">Store modules</h2>
            <p>Open a module to configure only the features that are enabled for this store.</p>
          </div>
        </div>
        <div className="aevo-module-grid">
          {enabledModules.map((module) => (
            <ModuleCardLink
              key={module.key}
              to={module.to}
              code={module.code}
              label={module.label}
              description={module.description}
            />
          ))}
          {canManage ? (
            <ModuleCardLink
              to={storePath(store.id, "apps")}
              code="Control plane"
              label="Apps & features"
              description="Enable or test application surfaces for this store."
            />
          ) : null}
        </div>
      </section>
    </> : null}
    {data.view === "settings" ? <StoreSettings data={data} busy={busy} /> : null}
    {data.view === "apps" ? <AppsWorkspace data={data} busy={busy} connection={connection} /> : null}
    {data.view === "catalog" ? <CatalogWorkspace data={data} busy={busy} /> : null}
  </>;
}
