import type {
  CatalogSnapshot,
  CustomerStoreProfile,
  StoreApplicationAccessSummary,
  StoreSummary
} from "@aevo/contracts";
import type { AccessDecisionResponse } from "@aevocado/api-contract";
import { ApiClientError } from "@aevocado/contracts";
import { isAccessAllowed } from "@aevocado/app-access";
import { Breadcrumbs, Button, Input, PermissionDeniedState, Select, StatusBadge } from "@aevocado/design-system";
import { Form, Link, redirect, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  createHubApiClient,
  requireHubAccess,
  requestCsrfHeaders
} from "../lib/auth.server";
import { hasHubPermission, type HubLoaderData } from "../lib/auth.shared";

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
  applications: StoreApplicationAccessSummary[];
  view: StoreView;
  catalog: CatalogSnapshot | null;
  catalogError?: string;
  permissionDenied?: "store.read";
}

type StoreActionResult =
  | { ok: false; message: string }
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

const applicationCodes = ["PLAY", "POS", "KIOSK", "QUEUE"] as const;
const catalogChannels = ["POS", "QR", "KIOSK", "PICKUP", "STAFF", "API"] as const;
const storeModes = ["POS", "KIOSK", "BOOKING", "POS_BOOKING", "CUSTOM"] as const;

const applicationLabels: Record<(typeof applicationCodes)[number], string> = {
  PLAY: "Play booking",
  POS: "POS operations",
  KIOSK: "Kiosk",
  QUEUE: "Queue display"
};

const applicationFeatures: Record<(typeof applicationCodes)[number], Array<{ label: string; description: string; href?: string }>> = {
  PLAY: [
    { label: "Bookings & availability", description: "Manage bookable resources and customer slots." },
    { label: "Booking policies", description: "Configure the rules used by the booking application." }
  ],
  POS: [
    { label: "Products & catalog", description: "Manage products, prices, availability, and menus.", href: "catalog" },
    { label: "Orders & payments", description: "Expose the store to POS order and payment workflows." }
  ],
  KIOSK: [
    { label: "Self-service catalog", description: "Use the store catalog in a kiosk ordering surface.", href: "catalog" },
    { label: "Kiosk configuration", description: "Prepare device and ordering settings for kiosk terminals." }
  ],
  QUEUE: [
    { label: "Queue display", description: "Allow this store to publish queue and readiness events." },
    { label: "Display devices", description: "Manage the devices assigned to the queue surface." }
  ]
};

function storePath(storeId: string, view?: StoreView): string {
  return `/stores/${encodeURIComponent(storeId)}${view && view !== "overview" ? `?view=${view}` : ""}`;
}

function readView(request: Request): StoreView {
  const value = new URL(request.url).searchParams.get("view");
  return value === "settings" || value === "apps" || value === "catalog" ? value : "overview";
}

function permissionDenied(permission: "store.read", hub: HubLoaderData, view: StoreView): StoreLoaderData {
  return { hub, store: null, profile: null, applications: [], view, catalog: null, permissionDenied: permission };
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

function isApplicationCode(value: string): value is (typeof applicationCodes)[number] {
  return applicationCodes.includes(value as (typeof applicationCodes)[number]);
}

function isCatalogChannel(value: string): value is (typeof catalogChannels)[number] {
  return catalogChannels.includes(value as (typeof catalogChannels)[number]);
}

function isStoreMode(value: string): value is (typeof storeModes)[number] {
  return storeModes.includes(value as (typeof storeModes)[number]);
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
  const hub = await requireHubAccess(request, storeId ? `/modern/stores/${encodeURIComponent(storeId)}` : "/modern/stores");
  if (!isAccessAllowed(hub.access)) return permissionDenied("store.read", hub, view);
  if (!storeId) return { hub, store: null, profile: null, applications: [], view, catalog: null };
  if (!hasHubPermission(hub, "store.read") && !hasHubPermission(hub, "store.manage") && !hasHubPermission(hub, "organization.manage")) {
    return permissionDenied("store.read", hub, view);
  }

  const api = createHubApiClient(request);
  try {
    const [storeResult, applicationResult, profileResult] = await Promise.all([
      api.request<{ store: StoreSummary }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}`),
      api.request<{ applications: StoreApplicationAccessSummary[] }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}/applications`),
      api.request<{ profile: CustomerStoreProfile | null }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}/customer-profile`)
    ]);
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
      applications: applicationResult.applications,
      profile: profileResult.profile,
      view,
      catalog,
      ...(catalogError ? { catalogError } : {})
    };
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) {
      return { hub, store: null, profile: null, applications: [], view, catalog: null };
    }
    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs): Promise<Response | StoreActionResult> {
  const storeId = params.storeId;
  const hub = await requireHubAccess(request, storeId ? `/modern/stores/${encodeURIComponent(storeId)}` : "/modern/stores");
  if (!isAccessAllowed(hub.access)) return { ok: false, message: "Hub access is required." };
  if (!storeId) return { ok: false, message: "Store context is missing." };

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const api = createHubApiClient(request);
  const canManage = hasHubPermission(hub, "store.manage") || hasHubPermission(hub, "organization.manage");
  const canManageCatalog = canManage || hasHubPermission(hub, "catalog.manage");

  try {
    if (intent === "test-application") {
      if (!hasHubPermission(hub, "store.read") && !canManage) return { ok: false, message: "Store read permission is required." };
      const applicationCode = textValue(form, "applicationCode", 16, true).toUpperCase();
      if (!isApplicationCode(applicationCode)) return { ok: false, message: "Choose a valid application." };
      const result = await api.request<{ connection: ApplicationConnectionTest }>(
        `/api/v1/hub/application-connections/${encodeURIComponent(applicationCode)}/test?storeId=${encodeURIComponent(storeId)}`
      );
      return { ok: true, connection: result.connection };
    }

    if (!canManage && !(canManageCatalog && (intent === "create-product" || intent === "update-availability"))) {
      return { ok: false, message: "Store management permission is required for this action." };
    }

    if (intent === "update-store-application") {
      const applicationCode = textValue(form, "applicationCode", 16, true).toUpperCase();
      const enabledValue = textValue(form, "enabled", 5, true);
      if (!isApplicationCode(applicationCode) || !["true", "false"].includes(enabledValue)) {
        return { ok: false, message: "Choose a valid application configuration." };
      }
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/applications/${encodeURIComponent(applicationCode)}`,
        {
          method: "PATCH",
          headers: requestCsrfHeaders(request),
          body: { enabled: enabledValue === "true" }
        }
      );
      return redirect(`${storePath(storeId, "apps")}&updated=${enabledValue === "true" ? "enabled" : "disabled"}&app=${encodeURIComponent(applicationCode)}`);
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
      const profile = await api.request<{ profile: CustomerStoreProfile | null }>(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/customer-profile`
      );
      const body = {
        publicSlug: publicSlugValue(textValue(form, "publicSlug", 63, true)),
        publicEnabled: String(form.get("publicEnabled") ?? "false") === "true",
        area: textValue(form, "area", 120, true),
        category: textValue(form, "category", 80, true),
        priceRange: textValue(form, "priceRange", 16, true),
        availabilityLabel: optionalTextValue(form, "availabilityLabel", 120) ?? null,
        description: optionalTextValue(form, "description", 1000) ?? null,
        imageUrl: profile.profile?.imageUrl ?? null,
        mediaUrls: profile.profile?.mediaUrls ?? [],
        facilities: profile.profile?.facilities ?? [],
        policySummary: profile.profile?.policySummary ?? null,
        latitude: profile.profile?.latitude ?? null,
        longitude: profile.profile?.longitude ?? null,
        rating: profile.profile?.rating ?? null,
        reviewCount: profile.profile?.reviewCount ?? 0
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
            currency: textValue(form, "productCurrency", 3, true).toUpperCase()
          }
        }
      );
      return redirect(`${storePath(storeId, "catalog")}&updated=product`);
    }

    if (intent === "update-availability") {
      const channel = textValue(form, "channel", 16, true).toUpperCase();
      const productId = textValue(form, "productId", 64, true);
      if (!isCatalogChannel(channel)) return { ok: false, message: "Choose a valid catalog channel." };
      await api.requestJson(
        `/api/v1/hub/stores/${encodeURIComponent(storeId)}/catalog/products/${encodeURIComponent(productId)}/availability`,
        {
          method: "PATCH",
          headers: requestCsrfHeaders(request),
          body: {
            channel,
            isAvailable: String(form.get("isAvailable") ?? "false") === "true",
            soldOut: String(form.get("soldOut") ?? "false") === "true"
          }
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

function StoreTabs({ storeId, active }: { storeId: string; active: StoreView }) {
  const tabs: Array<[StoreView, string]> = [["overview", "Overview"], ["settings", "Store settings"], ["apps", "Apps & features"], ["catalog", "Products & catalog"]];
  return <nav className="aevo-store-workspace-tabs" aria-label="Store workspace sections">{tabs.map(([view, label]) => <Link className={active === view ? "is-active" : ""} key={view} to={storePath(storeId, view)} aria-current={active === view ? "page" : undefined}>{label}</Link>)}</nav>;
}

function StoreSettings({ data, busy }: { data: StoreLoaderData; busy: boolean }) {
  const store = data.store;
  const profile = data.profile;
  if (!store) return null;
  const canManage = hasHubPermission(data.hub, "store.manage") || hasHubPermission(data.hub, "organization.manage");
  return <>
    <section className="aevo-settings-section" aria-labelledby="store-settings-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Store configuration</span><h2 id="store-settings-heading">Store identity & operations</h2><p>These values are stored against this branch and checked by Core API authorization.</p></div></div>
      <Form method="post" className="aevo-form-grid">
        <input type="hidden" name="intent" value="update-store" />
        <label>Store name<Input name="storeName" defaultValue={store.name} maxLength={160} required disabled={!canManage} /></label>
        <label>Code<Input name="storeCode" defaultValue={store.code} maxLength={32} required disabled={!canManage} /></label>
        <label>Mode<Select name="storeMode" defaultValue={store.storeMode ?? "POS"} disabled={!canManage}>{storeModes.map((mode) => <option key={mode}>{mode}</option>)}</Select></label>
        <label>Timezone<Input name="storeTimezone" defaultValue={store.timezone} maxLength={64} required disabled={!canManage} /></label>
        <label>Currency<Input name="storeCurrency" defaultValue={store.currency ?? "THB"} maxLength={8} required disabled={!canManage} /></label>
        <label>Phone<Input name="storePhone" defaultValue={store.phone ?? ""} maxLength={50} disabled={!canManage} /></label>
        <label className="aevo-field--wide">Address<Input name="storeAddress" defaultValue={store.address ?? ""} maxLength={500} disabled={!canManage} /></label>
        <label>Tax ID<Input name="storeTaxId" defaultValue={store.taxId ?? ""} maxLength={50} disabled={!canManage} /></label>
        <div className="aevo-form-actions aevo-field--wide">{canManage ? <Button variant="primary" type="submit" busy={busy} busyLabel="Saving store…">Save store settings</Button> : <span className="aevo-form-hint">Store management permission is required.</span>}</div>
      </Form>
    </section>
    <section className="aevo-settings-section" aria-labelledby="public-profile-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Customer App projection</span><h2 id="public-profile-heading">Public store profile</h2><p>Only the fields below are published to the customer-facing discovery surface.</p></div></div>
      <Form method="post" className="aevo-form-grid">
        <input type="hidden" name="intent" value="update-customer-profile" />
        <label>Public slug<Input name="publicSlug" defaultValue={profile?.publicSlug ?? store.code.toLowerCase()} maxLength={63} required disabled={!canManage} /></label>
        <label>Area<Input name="area" defaultValue={profile?.area ?? ""} maxLength={120} required disabled={!canManage} /></label>
        <label>Category<Input name="category" defaultValue={profile?.category ?? ""} maxLength={80} required disabled={!canManage} /></label>
        <label>Price range<Input name="priceRange" defaultValue={profile?.priceRange ?? "฿฿"} maxLength={16} required disabled={!canManage} /></label>
        <label>Availability label<Input name="availabilityLabel" defaultValue={profile?.availabilityLabel ?? ""} maxLength={120} disabled={!canManage} /></label>
        <label className="aevo-field--wide">Description<textarea name="description" defaultValue={profile?.description ?? ""} maxLength={1000} disabled={!canManage} /></label>
        <label className="aevo-choice"><input type="checkbox" name="publicEnabled" value="true" defaultChecked={profile?.publicEnabled === true} disabled={!canManage} /> Publish this profile</label>
        <div className="aevo-form-actions aevo-field--wide">{canManage ? <Button variant="secondary" type="submit" busy={busy} busyLabel="Saving profile…">Save public profile</Button> : <span className="aevo-form-hint">Store management permission is required.</span>}</div>
      </Form>
    </section>
    <section className="aevo-settings-section" aria-labelledby="reuse-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Branch acceleration</span><h2 id="reuse-heading">Reuse this configuration</h2><p>Save the current store as a reusable template or duplicate it for another branch. Products and menu availability are copied by SKU.</p></div></div>
      <div className="aevo-reuse-grid">
        <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="create-template" /><h3>Save as template</h3><label>Template name<Input name="templateName" maxLength={120} required disabled={!canManage} /></label><Button variant="secondary" type="submit" busy={busy} busyLabel="Saving template…" disabled={!canManage}>Save template</Button></Form>
        <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="duplicate-store" /><h3>Duplicate this store</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>New store name<Input name="duplicateName" maxLength={160} required disabled={!canManage} /></label><label>New code<Input name="duplicateCode" maxLength={32} required disabled={!canManage} /></label><label>Public slug<Input name="duplicatePublicSlug" maxLength={63} disabled={!canManage} /></label></div><Button variant="primary" type="submit" busy={busy} busyLabel="Duplicating store…" disabled={!canManage}>Create branch from store</Button></Form>
      </div>
    </section>
  </>;
}

function AppsWorkspace({ data, busy, connection }: { data: StoreLoaderData; busy: boolean; connection?: ApplicationConnectionTest }) {
  const canManage = hasHubPermission(data.hub, "store.manage") || hasHubPermission(data.hub, "organization.manage");
  const pendingApplication = useNavigation().formData?.get("applicationCode");
  return <section className="aevo-settings-section" aria-labelledby="store-apps-heading">
    <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Store-level access boundary</span><h2 id="store-apps-heading">Apps & features for this store</h2><p>An app must be enabled here before its workspace features are available. Member assignment and organization entitlement are still checked by the server.</p></div><span className="aevo-count-badge">{data.applications.filter((application) => application.status === "ACTIVE" && application.applicationActive).length} enabled</span></div>
    <div className="aevo-store-app-grid">
      {data.applications.map((application) => {
        const enabled = application.status === "ACTIVE" && application.applicationActive;
        const busyForApplication = busy && String(pendingApplication ?? "") === application.applicationCode;
        const test = connection?.application === application.applicationCode ? connection : undefined;
        return <article className={`aevo-store-app-card${enabled ? " is-enabled" : ""}`} key={application.applicationCode}>
          <div className="aevo-store-app-card__top"><span className="aevo-app-icon" aria-hidden="true">{application.applicationCode.slice(0, 2)}</span><span className={enabled ? "aevo-status aevo-status--success" : "aevo-status aevo-status--neutral"}>{enabled ? "Enabled" : application.applicationActive ? "Disabled" : "Registry disabled"}</span></div>
          <h3>{applicationLabels[application.applicationCode]}</h3>
          <p>{application.applicationCode} is {enabled ? "available" : "not available"} at {data.store?.name}.</p>
          <div className="aevo-feature-list">{applicationFeatures[application.applicationCode].map((feature) => <div className="aevo-feature-row" key={feature.label}><div><strong>{feature.label}</strong><small>{feature.description}</small></div>{enabled && feature.href ? <Link className="aevo-button aevo-button--secondary aevo-button--small" to={storePath(data.store?.id ?? "", feature.href as StoreView)}>Open</Link> : null}</div>)}</div>
          {canManage ? <Form method="post" aria-busy={busyForApplication}><input type="hidden" name="intent" value="update-store-application" /><input type="hidden" name="applicationCode" value={application.applicationCode} /><input type="hidden" name="enabled" value={enabled ? "false" : "true"} /><Button variant={enabled ? "secondary" : "primary"} type="submit" busy={busyForApplication} busyLabel="Saving…" disabled={!application.applicationActive}>{enabled ? "Disable at this store" : "Enable at this store"}</Button></Form> : <span className="aevo-form-hint">Store management permission is required.</span>}
          <Form method="post" className="aevo-connection-test-form"><input type="hidden" name="intent" value="test-application" /><input type="hidden" name="applicationCode" value={application.applicationCode} /><Button variant="ghost" type="submit" busy={busy && String(pendingApplication ?? "") === application.applicationCode && !busyForApplication} busyLabel="Testing…">Test connection</Button></Form>
          {test ? <p className={`aevo-connection-result is-${test.status.toLowerCase()}`} role="status">{test.status === "ONLINE" ? `Online · ${test.latencyMs}ms` : test.status === "NOT_CONFIGURED" ? "URL not configured" : `${test.status.replace("_", " ")} · ${test.latencyMs}ms`} · access {test.access.reason.toLowerCase().replaceAll("_", " ")}</p> : null}
        </article>;
      })}
    </div>
  </section>;
}

function CatalogWorkspace({ data, busy }: { data: StoreLoaderData; busy: boolean }) {
  const catalog = data.catalog;
  const canManage = hasHubPermission(data.hub, "catalog.manage") || hasHubPermission(data.hub, "store.manage") || hasHubPermission(data.hub, "organization.manage");
  if (data.catalogError || !catalog) return <section className="aevo-settings-section"><PermissionDeniedState title="Catalog is not enabled" description={data.catalogError ?? "Enable POS or Kiosk for this store before opening Products & catalog."} action={<Link className="aevo-button aevo-button--secondary" to={storePath(data.store?.id ?? "", "apps")}>Configure apps</Link>} /></section>;
  return <>
    <section className="aevo-settings-section" aria-labelledby="catalog-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">POS / Kiosk feature</span><h2 id="catalog-heading">Products &amp; catalog</h2><p>Products are organization-owned; availability and menus are scoped to this store.</p></div><span className="aevo-count-badge">{catalog.products.length} products</span></div>
      <div className="aevo-table-wrap"><table className="aevo-data-table"><thead><tr><th>Product</th><th>SKU</th><th>Price</th><th>POS availability</th><th>Store status</th></tr></thead><tbody>{catalog.products.length === 0 ? <tr><td colSpan={5}><span className="aevo-empty-state">No products have been created for this organization.</span></td></tr> : catalog.products.map((product) => { const availability = product.availability.find((item) => item.channel === "POS"); const enabled = availability?.isAvailable !== false; return <tr key={product.id}><td><strong>{product.name}</strong><small>{product.description || "No description"}</small></td><td><code>{product.sku}</code></td><td>{(product.basePriceMinor / 100).toFixed(2)} {product.currency}</td><td>{enabled ? "Available" : "Unavailable"}</td><td>{canManage ? <Form method="post"><input type="hidden" name="intent" value="update-availability" /><input type="hidden" name="productId" value={product.id} /><input type="hidden" name="channel" value="POS" /><input type="hidden" name="isAvailable" value={enabled ? "false" : "true"} /><input type="hidden" name="soldOut" value="false" /><Button variant="secondary" type="submit" busy={busy} busyLabel="Saving…">{enabled ? "Disable" : "Enable"}</Button></Form> : <span className="aevo-form-hint">Read only</span>}</td></tr>; })}</tbody></table></div>
      {canManage ? <Form method="post" className="aevo-inline-form"><input type="hidden" name="intent" value="create-product" /><h3>Add product</h3><div className="aevo-form-grid aevo-form-grid--compact"><label>SKU<Input name="productSku" maxLength={64} required /></label><label>Name<Input name="productName" maxLength={160} required /></label><label>Price minor units<Input name="basePriceMinor" inputMode="numeric" maxLength={12} required /></label><label>Currency<Input name="productCurrency" defaultValue={data.store?.currency ?? "THB"} maxLength={3} required /></label><label className="aevo-field--wide">Description<Input name="productDescription" maxLength={2000} /></label></div><Button variant="primary" type="submit" busy={busy} busyLabel="Creating product…">Create product</Button></Form> : <p className="aevo-form-hint">Catalog management permission is required.</p>}
    </section>
    <section className="aevo-settings-section" aria-labelledby="catalog-summary-heading"><div className="aevo-section-heading"><div><span className="aevo-eyebrow">Catalog structure</span><h2 id="catalog-summary-heading">Categories, menus &amp; modifiers</h2><p>These structures are ready for the next configuration step without loading them into the initial store workspace.</p></div></div><dl className="aevo-store-facts"><div><dt>Categories</dt><dd>{catalog.categories.length}</dd></div><div><dt>Menus</dt><dd>{catalog.menus.length}</dd></div><div><dt>Modifier groups</dt><dd>{catalog.modifierGroups.length}</dd></div><div><dt>Channels</dt><dd>{new Set(catalog.products.flatMap((product) => product.availability.map((item) => item.channel))).size}</dd></div></dl></section>
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

  return <>
    <Breadcrumbs className="aevo-page-breadcrumb" items={[{ label: "Hub", href: "/" }, { label: "Stores & branches", href: "/stores" }, { label: store.name }]} />
    <section className="aevo-page-heading"><div><StatusBadge tone={store.status === "ACTIVE" ? "success" : "warning"}>{store.status ?? "ACTIVE"}</StatusBadge><h1>{store.name}</h1><p>{store.code} · {store.timezone} · {store.currency ?? "THB"}</p></div><div className="aevo-page-heading__actions"><Link className="aevo-button aevo-button--secondary" to="/stores">All stores</Link><Link className="aevo-button aevo-button--secondary" to="/settings">Organization settings</Link></div></section>
    <StoreTabs storeId={store.id} active={data.view} />
    {actionData?.ok === false ? <div className="aevo-inline-alert aevo-inline-alert--error" role="alert">{actionData.message}</div> : updated ? <div className="aevo-inline-alert" role="status">Saved {updated} successfully.</div> : created ? <div className="aevo-inline-alert" role="status">Store created from this configuration.</div> : null}
    {busy ? <div className="aevo-loading-strip" role="status">Loading store workspace…</div> : null}
    {data.view === "overview" ? <>
      <section className="aevo-settings-section aevo-store-summary" aria-labelledby="store-summary-heading"><div className="aevo-section-heading"><div><span className="aevo-eyebrow">Store workspace</span><h2 id="store-summary-heading">{store.name}</h2><p>{store.address || "No address has been added yet."}{store.phone ? ` · ${store.phone}` : ""}</p></div><span className="aevo-count-badge">{data.applications.filter((application) => application.status === "ACTIVE" && application.applicationActive).length} apps enabled</span></div><dl className="aevo-store-facts"><div><dt>Store code</dt><dd>{store.code}</dd></div><div><dt>Operating mode</dt><dd>{store.storeMode ?? "—"}</dd></div><div><dt>Currency</dt><dd>{store.currency ?? "THB"}</dd></div><div><dt>Public profile</dt><dd>{data.profile?.publicEnabled ? "Published" : "Not published"}</dd></div></dl></section>
      <section className="aevo-settings-section" aria-labelledby="workspace-features-heading"><div className="aevo-section-heading"><div><span className="aevo-eyebrow">Enabled surfaces</span><h2 id="workspace-features-heading">Store modules</h2><p>Open a module to configure only the features that are enabled for this store.</p></div></div><div className="aevo-module-grid">{data.applications.filter((application) => application.status === "ACTIVE" && application.applicationActive).flatMap((application) => applicationFeatures[application.applicationCode].filter((feature) => feature.href).map((feature) => <Link className="aevo-module-card" key={`${application.applicationCode}-${feature.label}`} to={storePath(store.id, feature.href as StoreView)}><span className="aevo-eyebrow">{application.applicationCode}</span><strong>{feature.label}</strong><span>{feature.description}</span></Link>))}{canManage ? <Link className="aevo-module-card" to={storePath(store.id, "apps")}><span className="aevo-eyebrow">Control plane</span><strong>Apps &amp; features</strong><span>Enable or test application surfaces for this store.</span></Link> : null}</div></section>
    </> : null}
    {data.view === "settings" ? <StoreSettings data={data} busy={busy} /> : null}
    {data.view === "apps" ? <AppsWorkspace data={data} busy={busy} connection={connection} /> : null}
    {data.view === "catalog" ? <CatalogWorkspace data={data} busy={busy} /> : null}
  </>;
}
