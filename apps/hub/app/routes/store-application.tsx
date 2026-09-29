import type {
  HubStoreApplicationConfiguration,
  StoreApplicationAccessSummary,
  StoreSummary
} from "@aevocado/contracts";
import { ApiClientError } from "@aevocado/contracts";
import { isAccessAllowed } from "@aevocado/app-access";
import { Breadcrumbs, Button, PermissionDeniedState, StatusBadge } from "@aevocado/design-system";
import { Link, useFetcher, useLoaderData, useLocation, useNavigation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { createHubApiClient, requireHubAccess } from "../lib/auth.server";
import { hasHubPermission, type HubLoaderData } from "../lib/auth.shared";
import { StoreApplicationConfigurationForm } from "../components/store-application-configuration";

interface ApplicationConnectionTest {
  application: string;
  configured: boolean;
  url?: string;
  status: "ONLINE" | "HTTP_ERROR" | "OFFLINE" | "NOT_CONFIGURED";
  latencyMs: number;
  httpStatus?: number;
  access: { allowed: boolean; reason: string };
  checkedAt: string;
}

type ApplicationPageActionResult =
  | { ok: false; message: string; code?: string; applicationCode?: StoreApplicationAccessSummary["applicationCode"] }
  | { ok: true; connection: ApplicationConnectionTest };

interface StoreApplicationPageData {
  hub: HubLoaderData;
  store: StoreSummary | null;
  application: StoreApplicationAccessSummary | null;
  configuration: HubStoreApplicationConfiguration | null;
  configurationError?: string;
  permissionDenied?: "store.read";
  error?: string;
}

const applicationCodes = ["PLAY", "POS", "KIOSK", "QUEUE"] as const;

function isStoreApplicationCode(value: string): value is StoreApplicationAccessSummary["applicationCode"] {
  return applicationCodes.includes(value as StoreApplicationAccessSummary["applicationCode"]);
}

function applicationPagePath(storeId: string, applicationCode: StoreApplicationAccessSummary["applicationCode"]): string {
  return `/stores/${encodeURIComponent(storeId)}/apps/${encodeURIComponent(applicationCode)}`;
}

function parentStorePath(storeId: string): string {
  return `/stores/${encodeURIComponent(storeId)}`;
}

function capabilityLabel(capability: string): string {
  return capability
    .replace(/[._-]+/gu, " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function capabilityDescription(capability: string, applicationName: string): string {
  if (capability === "catalog") return "Shared product and catalog data available to this store.";
  return `${capabilityLabel(capability)} is provided by ${applicationName}.`;
}

function capabilityHref(storeId: string, capability: string): string | undefined {
  return capability === "catalog" ? `${parentStorePath(storeId)}?view=catalog` : undefined;
}

function applicationStatus(application: StoreApplicationAccessSummary): "ENABLED" | "DISABLED" | "UNAVAILABLE" {
  if (!application.applicationActive) return "UNAVAILABLE";
  return application.status === "ACTIVE" ? "ENABLED" : "DISABLED";
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<StoreApplicationPageData> {
  const storeId = params.storeId;
  const applicationCode = (params.applicationCode ?? "").trim().toUpperCase();
  const destination = storeId && isStoreApplicationCode(applicationCode)
    ? `/modern${applicationPagePath(storeId, applicationCode)}`
    : "/modern/stores";
  const hub = await requireHubAccess(request, destination);
  if (!isAccessAllowed(hub.access)) return { hub, store: null, application: null, configuration: null, permissionDenied: "store.read" };
  if (!storeId || !isStoreApplicationCode(applicationCode)) {
    return { hub, store: null, application: null, configuration: null, error: "This application page is not available." };
  }
  if (!hasHubPermission(hub, "store.read") && !hasHubPermission(hub, "store.manage") && !hasHubPermission(hub, "organization.manage")) {
    return { hub, store: null, application: null, configuration: null, permissionDenied: "store.read" };
  }

  const api = createHubApiClient(request);
  try {
    const existingStore = hub.stores.find((store) => store.id === storeId);
    const storeRequest: Promise<{ store: StoreSummary }> = existingStore
      ? Promise.resolve({ store: existingStore })
      : api.request<{ store: StoreSummary }>(`/api/v1/hub/stores/${encodeURIComponent(storeId)}`);
    const applicationsRequest = api.request<{ applications: StoreApplicationAccessSummary[] }>(
      `/api/v1/hub/stores/${encodeURIComponent(storeId)}/applications`
    );
    const [{ store }, { applications }] = await Promise.all([storeRequest, applicationsRequest]);
    const application = applications.find((candidate) => candidate.applicationCode === applicationCode) ?? null;
    if (!application) {
      return { hub, store, application: null, configuration: null, error: "This application is not registered for the current store." };
    }

    let configuration: HubStoreApplicationConfiguration | null = null;
    let configurationError: string | undefined;
    if (application.applicationActive && application.status === "ACTIVE" && (application.configSchemaRefs?.length ?? 0) > 0) {
      try {
        const result = await api.request<{ configuration: HubStoreApplicationConfiguration }>(
          `/api/v1/hub/stores/${encodeURIComponent(storeId)}/applications/${encodeURIComponent(applicationCode)}/config`
        );
        configuration = result.configuration;
      } catch (error) {
        if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) {
          configurationError = "Configuration is not available for this store application.";
        } else {
          throw error;
        }
      }
    }
    return { hub, store, application, configuration, ...(configurationError ? { configurationError } : {}) };
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) {
      return { hub, store: null, application: null, configuration: null, error: "This store application is not available for the current session." };
    }
    throw error;
  }
}

function ConnectionResult({ result }: { result: ApplicationPageActionResult | undefined }) {
  if (!result) return null;
  if (!result.ok) return <div className="aevo-inline-alert aevo-inline-alert--error" role="alert">{result.message}</div>;
  const connection = result.connection;
  const status = connection.status === "ONLINE" ? `Online · ${connection.latencyMs}ms` : connection.status === "NOT_CONFIGURED" ? "URL not configured" : `${connection.status.replace("_", " ")} · ${connection.latencyMs}ms`;
  return <div className={`aevo-inline-alert aevo-application-page__connection is-${connection.status.toLowerCase()}`} role="status">{status} · access {connection.access.reason.toLowerCase().replaceAll("_", " ")}</div>;
}

export default function StoreApplicationRoute() {
  const data = useLoaderData() as StoreApplicationPageData;
  const location = useLocation();
  const navigation = useNavigation();
  const actionFetcher = useFetcher<ApplicationPageActionResult>();
  const store = data.store;
  const application = data.application;
  if (data.permissionDenied) {
    return <main className="aevo-error-page"><PermissionDeniedState title="Store application access is restricted" description="The server resolved your Hub session, but this store application requires store.read or a higher organization permission." action={<Link className="aevo-button aevo-button--secondary" to="/stores">Back to Stores & branches</Link>} /></main>;
  }
  if (!store || !application) {
    return <main className="aevo-error-page"><PermissionDeniedState title="App workspace not found" description={data.error ?? "This application could not be loaded for the selected store."} action={<Link className="aevo-button aevo-button--secondary" to={store ? `${parentStorePath(store.id)}?view=apps` : "/stores"}>Back to Apps & features</Link>} /></main>;
  }

  const canManage = hasHubPermission(data.hub, "store.manage") || hasHubPermission(data.hub, "organization.manage");
  const status = applicationStatus(application);
  const enabled = status === "ENABLED";
  const busy = navigation.state !== "idle" || actionFetcher.state !== "idle";
  const pendingIntent = String(actionFetcher.formData?.get("intent") ?? navigation.formData?.get("intent") ?? "");
  const capabilities = application.capabilities ?? [];
  const updated = new URLSearchParams(location.search).get("updated");
  const storeAction = parentStorePath(store.id);

  return <>
    <Breadcrumbs className="aevo-page-breadcrumb" items={[{ label: "Hub", href: "/" }, { label: "Stores & branches", href: "/stores" }, { label: store.name, href: parentStorePath(store.id) }, { label: "Apps & features", href: `${storeAction}?view=apps` }, { label: application.applicationName }]} />
    <section className="aevo-page-heading aevo-application-page__heading">
      <div>
        <div className="aevo-page-heading__title-row">
          <span className="aevo-app-icon" aria-hidden="true">{application.applicationCode.slice(0, 2)}</span>
          <h1>{application.applicationName}</h1>
          <StatusBadge tone={status === "ENABLED" ? "success" : status === "DISABLED" ? "warning" : "neutral"}>{status}</StatusBadge>
        </div>
        <p className="aevo-page-heading__meta"><code>{application.applicationCode}</code><span>·</span><span>{store.name}</span><span>·</span><span>Store application workspace</span></p>
      </div>
      <div className="aevo-page-heading__actions">
        <Link className="aevo-button aevo-button--secondary" to={`${storeAction}?view=apps`}>Back to Apps &amp; features</Link>
        {enabled && (application.applicationCode === "PLAY" || application.applicationCode === "POS") ? <actionFetcher.Form method="post" action={storeAction} className="aevo-app-launch-form"><input type="hidden" name="intent" value="launch-application" /><input type="hidden" name="applicationCode" value={application.applicationCode} /><Button variant="primary" type="submit" busy={busy && pendingIntent === "launch-application"} busyLabel="Opening app…">Open {application.applicationName}</Button></actionFetcher.Form> : null}
      </div>
    </section>

    <section className="aevo-scope-banner aevo-scope-banner--store" aria-label={`${store.name} application scope`}>
      <div className="aevo-scope-banner__content"><span className="aevo-scope-banner__icon" aria-hidden="true">APP</span><div><span className="aevo-eyebrow">Store application context</span><p>You are viewing <strong>{application.applicationName}</strong> for <strong>{store.name}</strong>. App status and settings here apply only to this store.</p></div></div>
      <StatusBadge tone="success">{store.code} · Store scope</StatusBadge>
    </section>

    {updated ? <div className="aevo-inline-alert" role="status">Saved {updated} successfully.</div> : null}
    <ConnectionResult result={actionFetcher.data} />

    <section className="aevo-application-page__summary" aria-label={`${application.applicationName} summary`}>
      <article><span className="aevo-eyebrow">Store access</span><strong>{status}</strong><small>{enabled ? "This app is available in the selected store." : application.applicationActive ? "Enable it here to make the app available." : "The Core registry currently marks this app unavailable."}</small></article>
      <article><span className="aevo-eyebrow">Capabilities</span><strong>{capabilities.length}</strong><small>Features declared by the app manifest.</small></article>
      <article><span className="aevo-eyebrow">Typed settings</span><strong>{data.configuration?.schemas.length ?? application.configSchemaRefs?.length ?? 0}</strong><small>Core-validated configuration schema(s).</small></article>
    </section>

    <section className="aevo-settings-section" aria-labelledby="application-overview-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Application overview</span><h2 id="application-overview-heading">What this app provides</h2><p>These capabilities come from the versioned application manifest. The Hub does not invent app data or bypass the application boundary.</p></div></div>
      <dl className="aevo-store-facts aevo-application-page__facts"><div><dt>Application code</dt><dd><code>{application.applicationCode}</code></dd></div><div><dt>Store</dt><dd>{store.name}</dd></div><div><dt>Store mode</dt><dd>{store.storeMode ?? "—"}</dd></div><div><dt>Configuration</dt><dd>{enabled && data.configuration?.schemas.length ? "Available" : "Not available"}</dd></div></dl>
      {capabilities.length > 0 ? <div className="aevo-feature-list aevo-application-page__capabilities">{capabilities.map((capability) => { const href = capabilityHref(store.id, capability); return <div className="aevo-feature-row" key={capability}><div><strong>{capabilityLabel(capability)}</strong><small>{capabilityDescription(capability, application.applicationName)}</small></div>{href ? <Link className="aevo-button aevo-button--secondary aevo-button--small" to={href}>Open feature</Link> : null}</div>; })}</div> : <div className="aevo-app-config-empty" role="status">No capability details are published for this application yet.</div>}
    </section>

    <section className="aevo-settings-section" aria-labelledby="application-access-heading">
      <div className="aevo-section-heading"><div><span className="aevo-eyebrow">Store access</span><h2 id="application-access-heading">Availability &amp; connection</h2><p>Use this page to review the app before entering its full workspace. Store access remains controlled by Core authorization and entitlement checks.</p></div></div>
      <div className="aevo-application-page__actions">
        {canManage && application.applicationActive ? <actionFetcher.Form method="post" action={storeAction}><input type="hidden" name="intent" value="update-store-application" /><input type="hidden" name="applicationCode" value={application.applicationCode} /><input type="hidden" name="enabled" value={enabled ? "false" : "true"} /><Button variant={enabled ? "secondary" : "primary"} type="submit" busy={busy && pendingIntent === "update-store-application"} busyLabel="Saving…">{enabled ? "Disable at this store" : "Enable at this store"}</Button></actionFetcher.Form> : null}
        <actionFetcher.Form method="post" action={storeAction}><input type="hidden" name="intent" value="test-application" /><input type="hidden" name="applicationCode" value={application.applicationCode} /><Button variant="ghost" type="submit" busy={busy && pendingIntent === "test-application"} busyLabel="Testing…">Test connection</Button></actionFetcher.Form>
        {!canManage ? <span className="aevo-form-hint">Store management permission is required to change availability or configuration.</span> : null}
      </div>
    </section>

    {enabled && data.configuration?.schemas.length ? <section className="aevo-settings-section" aria-labelledby="application-config-heading"><div className="aevo-section-heading"><div><span className="aevo-eyebrow">Core-validated settings</span><h2 id="application-config-heading">Configure {application.applicationName}</h2><p>Settings are shown on this app page instead of a popup. Core validates the schema and stores only non-secret values.</p></div></div><div className="aevo-app-config-stack">{data.configuration.schemas.map((schema) => <StoreApplicationConfigurationForm key={schema.schemaRef} action={storeAction} applicationCode={application.applicationCode} schema={schema} canManage={canManage} busy={busy && pendingIntent === "update-application-config"} />)}</div></section> : enabled && data.configurationError ? <section className="aevo-settings-section"><div className="aevo-app-config-empty" role="status">{data.configurationError}</div></section> : null}
  </>;
}
