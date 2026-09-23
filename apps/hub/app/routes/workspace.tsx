import { Link } from "react-router";
import { Card, StatusBadge } from "@aevocado/design-system";
import { useHubLoaderData } from "./hub-layout";

const modules = [
  { name: "Organization", description: "Keep organization defaults, members, and access boundaries in one control plane.", href: "/settings", label: "Manage settings" },
  { name: "Stores & branches", description: "Manage branch records and the public profiles shared with Aevo Go.", href: "/stores", label: "Manage stores" },
  { name: "Applications", description: "Launch only the first-party apps assigned to this organization.", href: "/settings#applications", label: "Review assignments" },
  { name: "Billing", description: "Expose subscription and entitlement state without letting the client decide access.", href: "/settings#billing", label: "View entitlement state" }
] as const;

export default function Workspace() {
  const { me, access } = useHubLoaderData();
  const organizationId = access.organizationId ?? me.principal?.organizationId ?? "—";
  const permissionPreview = access.permissions.slice(0, 6);

  return (
    <>
      <section className="aevo-page-heading">
        <div>
          <StatusBadge tone="success">Hub assignment verified</StatusBadge>
          <h1>Good morning, {me.user.displayName || me.user.email}</h1>
          <p>This React Router Framework Mode surface is the canonical Aevo Hub workspace. It reads the gateway contract and keeps authorization decisions on the server.</p>
        </div>
        <Link className="aevo-button aevo-button--primary" to="/settings">Open organization settings</Link>
      </section>

      <section className="aevo-kpi-grid" aria-label="Access summary">
        <Card className="aevo-kpi"><span>Organization</span><strong>{organizationId}</strong></Card>
        <Card className="aevo-kpi"><span>Role</span><strong>{access.role ?? me.principal?.role ?? "—"}</strong></Card>
        <Card className="aevo-kpi"><span>Permissions</span><strong>{access.permissions.length}</strong></Card>
      </section>

      <section className="aevo-module-grid" aria-label="Hub modules">
        {modules.map((module) => (
          <Card className="aevo-module" key={module.name}>
            <h2>{module.name}</h2>
            <p>{module.description}</p>
            <Link className="aevo-button aevo-button--secondary" to={module.href}>{module.label}</Link>
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
