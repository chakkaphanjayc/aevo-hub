import type { AppSubscriptionSummary, Permission, ResolvedEntitlements } from "@aevocado/contracts";
import { Breadcrumbs, StatusBadge } from "@aevocado/design-system";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { isAccessAllowed } from "@aevocado/app-access";
import { CapabilityNotice, PlatformPage } from "../components/platform-settings";
import { createHubApiClient, requireHubAccess } from "../lib/auth.server";
import { hasHubPermission, type HubLoaderData } from "../lib/auth.shared";
import { loadBillingCoreSnapshot, unexposedCapabilities } from "../lib/platform-capabilities.server";
import type { CoreRead } from "../lib/platform-capabilities.server";
import "../platform-settings.css";

export function meta() {
  return [{ title: "Billing & payment | Aevo Hub" }];
}

export interface BillingLoaderData {
  hub: HubLoaderData;
  permissionDenied?: Permission;
  subscriptions?: CoreRead<AppSubscriptionSummary[]>;
  entitlements?: CoreRead<ResolvedEntitlements>;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<BillingLoaderData> {
  const hub = await requireHubAccess(request, "/billing");
  if (!isAccessAllowed(hub.access)) return { hub, permissionDenied: "organization.read" };
  if (!hasHubPermission(hub, "organization.read")) return { hub, permissionDenied: "organization.read" };
  const snapshot = await loadBillingCoreSnapshot(createHubApiClient(request));
  return { hub, ...snapshot };
}

function formatDate(value?: string | null): string {
  if (!value) return "Not provided by Core";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(timestamp) : value;
}

function ReadState<T>({ read, label }: { read?: CoreRead<T>; label: string }) {
  if (!read) return <CapabilityNotice state="loading" title={`Loading ${label}`} description="Reading this state from Core." />;
  if (read.state === "denied") return <CapabilityNotice state="denied" title={`${label} is restricted`} description={read.message} code={read.code} />;
  if (read.state === "unavailable") return <CapabilityNotice state="unavailable" title={`${label} is unavailable`} description={read.message} code={read.code} />;
  if (read.state === "error") return <CapabilityNotice state="error" title={`${label} could not be loaded`} description={read.message} code={read.code} />;
  return null;
}

function SubscriptionList({ subscriptions }: { subscriptions: AppSubscriptionSummary[] }) {
  if (subscriptions.length === 0) {
    return <CapabilityNotice state="empty" title="No subscriptions returned" description="Core returned an empty subscription list for this organization." />;
  }
  return (
    <div className="aevo-platform-table-wrap">
      <table className="aevo-platform-table">
        <caption>Subscriptions returned by Core</caption>
        <thead><tr><th>Application</th><th>Plan</th><th>Status</th><th>Current period</th><th>Entitlement</th></tr></thead>
        <tbody>{subscriptions.map((subscription) => <tr key={subscription.id}>
          <td><strong>{subscription.appId}</strong>{subscription.storeId ? <small>Store scope {subscription.storeId}</small> : <small>Organization scope</small>}</td>
          <td>{subscription.planCode}</td>
          <td><StatusBadge tone={subscription.status === "ACTIVE" || subscription.status === "TRIAL" ? "success" : "warning"}>{subscription.status}</StatusBadge></td>
          <td>{formatDate(subscription.currentPeriodStartsAt)} – {formatDate(subscription.currentPeriodEndsAt)}</td>
          <td>{subscription.isEntitled ? "Allowed by Core" : "Not entitled"}</td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function EntitlementSummary({ entitlements }: { entitlements: ResolvedEntitlements }) {
  const usageKeys = Object.keys(entitlements.usage);
  const features = Object.entries(entitlements.features);
  return (
    <section className="aevo-platform-section" aria-labelledby="billing-entitlements-heading">
      <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Core projection</span><h2 id="billing-entitlements-heading">Entitlements and usage</h2><p>These values come from Core’s organization entitlement projection.</p></div><StatusBadge tone={entitlements.status === "ACTIVE" ? "success" : "warning"}>{entitlements.status}</StatusBadge></div>
      <dl className="aevo-platform-facts"><div><dt>Plan</dt><dd>{entitlements.planId}</dd></div><div><dt>Organization</dt><dd><code>{entitlements.organizationId}</code></dd></div></dl>
      <div className="aevo-platform-table-wrap">
        <table className="aevo-platform-table"><caption>Usage and plan limits returned by Core</caption><thead><tr><th>Meter</th><th>Usage</th><th>Limit</th></tr></thead>
          <tbody>{usageKeys.length > 0 ? usageKeys.map((key) => {
            const limit = entitlements.limits[key];
            return <tr key={key}><th scope="row">{key}</th><td>{entitlements.usage[key]}</td><td>{limit === undefined ? "No limit returned" : limit === null ? "Unlimited" : limit}</td></tr>;
          }) : <tr><td colSpan={3}>Core returned no usage meters.</td></tr>}</tbody>
        </table>
      </div>
      <div className="aevo-platform-feature-list"><h3>Feature entitlements</h3>{features.length > 0 ? <ul>{features.map(([feature, enabled]) => <li key={feature}><span>{feature}</span><StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Not enabled"}</StatusBadge></li>)}</ul> : <p>Core returned no feature flags.</p>}</div>
    </section>
  );
}

export default function BillingRoute() {
  const data = useLoaderData() as BillingLoaderData;
  if (data.permissionDenied) {
    return <PlatformPage eyebrow="Organization settings" title="Billing & payment" description="Subscription and entitlement state remains owned by Core."><Breadcrumbs items={[{ label: "Hub", href: "/" }, { label: "Billing & payment" }]} /><CapabilityNotice state="denied" title="Billing access is restricted" description="Core requires organization read access before this billing summary can be loaded." /></PlatformPage>;
  }
  const subscriptionData = data.subscriptions;
  const entitlementData = data.entitlements;
  return (
    <PlatformPage eyebrow="Billing & commerce" title="Billing & payment" description="Review Core-owned subscriptions, entitlements, and usage. Provider billing actions appear only when Core exposes them.">
      <Breadcrumbs items={[{ label: "Hub", href: "/" }, { label: "Billing & payment" }]} />
      <section className="aevo-platform-section" id="subscriptions" aria-labelledby="billing-subscriptions-heading">
        <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Subscription projection</span><h2 id="billing-subscriptions-heading">Subscriptions</h2><p>Plan state and entitlement are read from Core. Hub does not calculate charges.</p></div></div>
        <ReadState read={subscriptionData} label="Subscription data" />
        {subscriptionData?.state === "available" ? <SubscriptionList subscriptions={subscriptionData.data} /> : null}
      </section>
      {entitlementData?.state === "available" ? <EntitlementSummary entitlements={entitlementData.data} /> : <section className="aevo-platform-section" aria-labelledby="billing-usage-heading"><div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Core projection</span><h2 id="billing-usage-heading">Entitlements and usage</h2></div></div><ReadState read={entitlementData} label="Entitlement and usage data" /></section>}
      <section className="aevo-platform-section" aria-labelledby="billing-actions-heading">
        <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Provider capability</span><h2 id="billing-actions-heading">Payment methods and billing portal</h2><p>Hub will not collect payment details or manufacture payment history.</p></div></div>
        <div className="aevo-platform-capability-grid">
          <div id="payment-methods"><CapabilityNotice state="unavailable" title="Billing portal is unavailable" description={unexposedCapabilities.billingPortal.message} code={unexposedCapabilities.billingPortal.code} /></div>
          <div id="transaction-history"><CapabilityNotice state="unavailable" title="Payment history is unavailable" description={unexposedCapabilities.paymentHistory.message} code={unexposedCapabilities.paymentHistory.code} /></div>
        </div>
      </section>
    </PlatformPage>
  );
}
