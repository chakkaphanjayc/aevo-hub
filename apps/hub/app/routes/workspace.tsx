import { Link, useLoaderData } from "react-router";
import type { ClientLoaderFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ApiClientError } from "@aevocado/contracts";
import type { HubDashboardProjection, HubDashboardProjectionResponse } from "@aevocado/contracts";
import { isAccessAllowed } from "@aevocado/app-access";
import { Card, StatusBadge } from "@aevocado/design-system";
import { createHubApiClient, requireHubAccess } from "../lib/auth.server";
import type { HubLoaderData } from "../lib/auth.shared";
import { useHubLoaderData } from "./hub-layout";

interface WorkspaceLoaderData {
  hub: HubLoaderData;
  projection: HubDashboardProjection | null;
  projectionError?: string;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<WorkspaceLoaderData> {
  const hub = await requireHubAccess(request, "/modern");
  if (!isAccessAllowed(hub.access)) return { hub, projection: null };

  try {
    const response = await createHubApiClient(request).request<HubDashboardProjectionResponse>("/api/v1/hub/overview/organization");
    return { hub, projection: response.projection };
  } catch (error) {
    if (error instanceof ApiClientError) {
      return { hub, projection: null, projectionError: error.message };
    }
    return { hub, projection: null, projectionError: error instanceof Error ? error.message : "Dashboard projection unavailable" };
  }
}

export async function clientLoader({
  serverLoader
}: ClientLoaderFunctionArgs): Promise<WorkspaceLoaderData> {
  // The payload contains the Hub access projection. Never serve that
  // authorization-bearing object from a browser cache; Core/Hub remain the
  // source of truth for every navigation.
  return await serverLoader() as WorkspaceLoaderData;
}

const modules = [
  { name: "Organization", description: "Keep organization defaults, members, and access boundaries in one control plane.", href: "/settings", label: "Manage settings" },
  { name: "Stores & branches", description: "Manage branch records and the public profiles shared with Aevo Go.", href: "/stores", label: "Manage stores" },
  { name: "Applications", description: "Review installed apps, the Core-owned catalog, assignments, and store entry points.", href: "/settings#applications", label: "Review applications" },
  { name: "Entitlements & billing", description: "Expose subscription and entitlement state without letting the client decide access.", href: "/settings#applications", label: "View entitlement state" }
] as const;

export default function Workspace() {
  const data = useLoaderData() as WorkspaceLoaderData;
  const { me, access } = useHubLoaderData();
  const organizationId = access.organizationId ?? me.principal?.organizationId ?? "—";
  const permissionPreview = access.permissions.slice(0, 6);
  const projection = data.projection;
  const stats = projection?.stats;
  const freshness = projection?.freshness;

  function statValue(key: string): string {
    const value = stats?.[key];
    return typeof value === "number" ? value.toLocaleString() : "—";
  }

  function freshnessTone(state: HubDashboardProjection["freshness"]["state"]): "success" | "warning" | "danger" {
    return state === "fresh" ? "success" : state === "unavailable" ? "danger" : "warning";
  }

  return (
    <>
      <section className="aevo-page-heading">
        <div>
          <div className="aevo-page-heading__title-row">
            <h1>Good morning, {me.user.displayName || me.user.email}</h1>
            <StatusBadge tone="success">Hub assignment verified</StatusBadge>
          </div>
          <p>This React Router Framework Mode surface is the canonical Aevo Hub workspace. It reads the gateway contract and keeps authorization decisions on the server.</p>
        </div>
        <Link className="aevo-button aevo-button--primary" to="/settings" prefetch="intent">Open organization settings</Link>
      </section>

      <section className="aevo-kpi-grid" aria-label="Access summary">
        <Card className="aevo-kpi"><span>Organization</span><strong>{organizationId}</strong></Card>
        <Card className="aevo-kpi"><span>Role</span><strong>{access.role ?? me.principal?.role ?? "—"}</strong></Card>
        <Card className="aevo-kpi"><span>Permissions</span><strong>{access.permissions.length}</strong></Card>
      </section>

      <Card as="section" id="analytics-heading" className="aevo-module" aria-labelledby="dashboard-health-heading">
        <div className="aevo-section-heading">
          <div>
            <span className="aevo-eyebrow">Core-owned dashboard projection</span>
            <h2 id="dashboard-health-heading">Workspace health</h2>
            <p>Counts come from the tenant-scoped Core API read model. The freshness state stays visible when an application source is partial or unavailable.</p>
          </div>
          {freshness ? <StatusBadge tone={freshnessTone(freshness.state)}>{freshness.state}</StatusBadge> : <StatusBadge tone="warning">unavailable</StatusBadge>}
        </div>
        {projection ? (
          <>
            <div className="aevo-kpi-grid" aria-label="Workspace health metrics">
              <Card className="aevo-kpi"><span>Active stores</span><strong>{statValue("totalStores")}</strong></Card>
              <Card className="aevo-kpi"><span>Active members</span><strong>{statValue("totalMembers")}</strong></Card>
              <Card className="aevo-kpi"><span>Active apps</span><strong>{statValue("activeApps")}</strong></Card>
              <Card className="aevo-kpi"><span>Active devices</span><strong>{statValue("activeDevices")}</strong></Card>
            </div>
            <p className="aevo-form-hint">
              Generated {new Date(freshness?.generatedAt ?? Date.now()).toLocaleString()} · {projection.sources.length} application source{projection.sources.length === 1 ? "" : "s"} checked
              {freshness?.errorCode ? ` · ${freshness.errorCode}` : ""}
            </p>
          </>
        ) : (
          <p className="aevo-form-hint" role="status">{data.projectionError ?? "The dashboard projection is not available yet. Workspace actions remain available."}</p>
        )}
      </Card>

      <section className="aevo-module-grid" aria-label="Hub modules">
        {modules.map((module) => (
          <Card className="aevo-module" key={module.name}>
            <h2>{module.name}</h2>
            <p>{module.description}</p>
            <Link className="aevo-button aevo-button--secondary" to={module.href} prefetch="intent">{module.label}</Link>
          </Card>
        ))}
      </section>

      <Card as="section" className="aevo-module" style={{ marginTop: "var(--aevo-space-6)" }}>
        <h2>Effective Hub permissions</h2>
        <p>These permissions are a server response. The browser only uses them for presentation and navigation; mutations still enforce the same policy in the gateway.</p>
        {permissionPreview.length > 0 ? (
          <ul className="aevo-permission-list" aria-label="Permission preview">
            {permissionPreview.map((permission) => <li key={permission}>{permission}</li>)}
          </ul>
        ) : <span className="aevo-status aevo-status--warning">No permissions returned</span>}
      </Card>
    </>
  );
}
