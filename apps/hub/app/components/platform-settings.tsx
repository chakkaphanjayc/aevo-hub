import { EmptyState, ErrorState, LoadingState, PermissionDeniedState, StatusBadge } from "@aevocado/design-system";
import type { ReactNode } from "react";
import { Form, Link, useLocation } from "react-router";
import type { StructuredListQuery } from "../lib/structured-list";

export type CapabilityNoticeState = "loading" | "empty" | "error" | "denied" | "entitlement" | "unavailable";

export function CapabilityNotice({
  state,
  title,
  description,
  code,
  action,
}: {
  state: CapabilityNoticeState;
  title: string;
  description: string;
  code?: string;
  action?: ReactNode;
}) {
  const props = { title, description, action, className: "aevo-platform-state" };
  return (
    <div className="aevo-platform-capability" data-capability-state={state}>
      {state === "loading" ? <LoadingState {...props} /> : null}
      {state === "empty" ? <EmptyState {...props} /> : null}
      {state === "error" ? <ErrorState {...props} /> : null}
      {state === "denied" || state === "entitlement" ? <PermissionDeniedState {...props} /> : null}
      {state === "unavailable" ? (
        <section className="aevo-platform-unavailable" role="status" aria-live="polite">
          <div className="aevo-platform-unavailable__heading"><StatusBadge tone="warning">Unavailable</StatusBadge><h3>{title}</h3></div>
          <p>{description}</p>
          {code ? <code>{code}</code> : null}
          {action ? <div className="aevo-platform-unavailable__action">{action}</div> : null}
        </section>
      ) : null}
    </div>
  );
}

const workspaceLinks = [
  { to: "/billing", label: "Billing" },
  { to: "/access", label: "Access" },
  { to: "/reports", label: "Reports" },
  { to: "/data", label: "Data operations" },
] as const;

export function PlatformSettingsNavigation() {
  const location = useLocation();
  return (
    <nav className="aevo-platform-nav" aria-label="Platform workspaces">
      {workspaceLinks.map((item) => {
        const active = location.pathname === item.to;
        return <Link key={item.to} to={item.to} aria-current={active ? "page" : undefined}>{item.label}</Link>;
      })}
    </nav>
  );
}

export function PlatformPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="aevo-platform-page">
      <header className="aevo-platform-page__heading">
        <div><span className="aevo-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      </header>
      <PlatformSettingsNavigation />
      {children}
    </div>
  );
}

export function StructuredRecordsToolbar({
  query,
  roleOptions,
  statusOptions,
  scopeOptions,
  sortOptions,
  columnOptions,
  resetTo,
}: {
  query: StructuredListQuery;
  roleOptions: readonly string[];
  statusOptions: readonly string[];
  scopeOptions: readonly string[];
  sortOptions: readonly { value: string; label: string }[];
  columnOptions: readonly { value: string; label: string }[];
  resetTo: string;
}) {
  return (
    <Form method="get" className="aevo-platform-list-controls">
      <input type="hidden" name="page" value="1" />
      <div className="aevo-platform-list-controls__primary">
        <label className="aevo-platform-search"><span>Search members</span><input type="search" name="q" defaultValue={query.q} placeholder="Name or email" /></label>
        <label><span>Sort by</span><select name="sort" defaultValue={query.sort}>{sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>Direction</span><select name="direction" defaultValue={query.direction}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
        <label><span>Rows</span><select name="pageSize" defaultValue={String(query.pageSize)}>{[10, 25, 50].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
      </div>
      <details className="aevo-platform-advanced-filters">
        <summary>Advanced filters and columns</summary>
        <div className="aevo-platform-list-controls__advanced">
          <label><span>Organization role</span><select name="role" defaultValue={query.role}><option value="">All roles</option>{roleOptions.map((role) => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}</select></label>
          <label><span>Membership status</span><select name="status" defaultValue={query.status}><option value="">All statuses</option>{statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
          <label><span>Assignment scope</span><select name="scope" defaultValue={query.scope}><option value="">All scopes</option>{scopeOptions.map((scope) => <option key={scope} value={scope}>{scope}</option>)}</select></label>
          <fieldset><legend>Visible columns</legend><div className="aevo-platform-column-options">{columnOptions.map((column) => <label key={column.value}><input type="checkbox" name="columns" value={column.value} defaultChecked={query.columns.includes(column.value)} /><span>{column.label}</span></label>)}</div></fieldset>
        </div>
      </details>
      <div className="aevo-platform-list-controls__actions"><button className="aevo-button aevo-button--primary" type="submit">Apply filters</button><Link className="aevo-button aevo-button--ghost" to={resetTo}>Reset</Link></div>
    </Form>
  );
}
