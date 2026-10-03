import { Button, StatusBadge } from "@aevocado/design-system";
import { Form, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { isAccessAllowed } from "@aevocado/app-access";
import { CapabilityNotice, PlatformPage } from "../components/platform-settings";
import { requireHubAccess } from "../lib/auth.server";
import type { HubLoaderData } from "../lib/auth.shared";
import { unexposedCapabilities } from "../lib/platform-capabilities.server";
import "../platform-settings.css";

export function meta() {
  return [{ title: "Reports | Aevo Hub" }];
}

interface ReportsLoaderData {
  hub: HubLoaderData;
  capability: typeof unexposedCapabilities.queryPlatform;
  accessBlocked?: { state: "denied" | "entitlement"; reason: string };
  query: {
    model: string;
    q: string;
    filter: string;
    sort: string;
    group: string;
    page: string;
    pageSize: string;
  };
}

export async function loader({ request }: LoaderFunctionArgs): Promise<ReportsLoaderData> {
  const hub = await requireHubAccess(request, "/reports");
  const url = new URL(request.url);
  const reason = hub.access.reason;
  const entitlementReasons = new Set(["ENTITLEMENT_REQUIRED", "ENTITLEMENT_INACTIVE", "ENTITLEMENT_EXPIRED", "ENTITLEMENT_PROJECTION_UNAVAILABLE"]);
  return {
    hub,
    capability: unexposedCapabilities.queryPlatform,
    ...(!isAccessAllowed(hub.access) ? { accessBlocked: { state: entitlementReasons.has(reason) ? "entitlement" as const : "denied" as const, reason } } : {}),
    query: {
      model: (url.searchParams.get("model") ?? "").slice(0, 120),
      q: (url.searchParams.get("q") ?? "").slice(0, 160),
      filter: (url.searchParams.get("filter") ?? "").slice(0, 500),
      sort: (url.searchParams.get("sort") ?? "").slice(0, 120),
      group: (url.searchParams.get("group") ?? "").slice(0, 120),
      page: (url.searchParams.get("page") ?? "1").slice(0, 12),
      pageSize: (url.searchParams.get("pageSize") ?? "25").slice(0, 12),
    },
  };
}

export default function ReportsRoute() {
  const data = useLoaderData() as ReportsLoaderData;
  if (data.accessBlocked) {
    return <PlatformPage eyebrow="Query Platform" title="Reports" description="Report permissions and entitlements are resolved by Core."><CapabilityNotice state={data.accessBlocked.state} title={data.accessBlocked.state === "entitlement" ? "Hub entitlement is blocked" : "Hub access is restricted"} description={`Core returned ${data.accessBlocked.reason}.`} code={data.accessBlocked.reason} /></PlatformPage>;
  }
  return (
    <PlatformPage eyebrow="Query Platform" title="Reports" description="Build a report from Core-published models, save its definition, and track Core-owned run and export jobs.">
      <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Report workspace</span><h2>Model and query</h2><p>Query state is reflected in the URL. Report execution stays disabled until Core exposes Query Platform metadata and actions.</p></div><StatusBadge tone="warning">Metadata unavailable</StatusBadge></div>
      <section className="aevo-platform-section" aria-labelledby="report-query-heading">
        <Form method="get" className="aevo-platform-query-form" aria-label="Report query controls">
          <input type="hidden" name="model" value={data.query.model} /><input type="hidden" name="filter" value={data.query.filter} /><input type="hidden" name="sort" value={data.query.sort} /><input type="hidden" name="group" value={data.query.group} /><input type="hidden" name="page" value="1" />
          <label><span>Report model</span><select name="model-selection" defaultValue={data.query.model} disabled aria-describedby="report-model-help"><option value="">No Core models available</option></select></label>
          <label><span>Search</span><input type="search" name="q" defaultValue={data.query.q} placeholder="Search report records" /></label>
          <details className="aevo-platform-advanced-filters"><summary>Filters, sort, and grouping</summary><div className="aevo-platform-query-grid">
            <label><span>Filter field</span><select value="" disabled><option value="">Waiting for field metadata</option></select></label>
            <label><span>Sort field</span><select defaultValue={data.query.sort} disabled><option value="">Waiting for sortable fields</option></select></label>
            <label><span>Group by</span><select defaultValue={data.query.group} disabled><option value="">Waiting for groupable fields</option></select></label>
            <label><span>Rows per page</span><select name="pageSize" defaultValue={data.query.pageSize}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label>
          </div></details>
          <p id="report-model-help" className="aevo-platform-inline-note">{data.capability.message}</p>
          <div className="aevo-platform-list-controls__actions"><Button type="submit" variant="secondary">Update URL query</Button><Button type="button" variant="primary" disabled title="Core report execution is unavailable">Run report</Button><Button type="button" variant="ghost" disabled title="Core full-result export is unavailable">Export report result</Button></div>
        </Form>
      </section>
      <section className="aevo-platform-section" aria-labelledby="report-result-heading"><div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Report output</span><h2 id="report-result-heading">Results and job status</h2><p>Hub shows run and export status only when those jobs are returned by Core.</p></div></div><div className="aevo-platform-capability-grid"><CapabilityNotice state="unavailable" title="Report results unavailable" description="There is no Core report-run endpoint in the backend contract currently available to this worktree." code="CORE_REPORT_RUN_NOT_EXPOSED" /><CapabilityNotice state="unavailable" title="Run and export status unavailable" description="Core does not expose report job identifiers, progress, retry, or result-download status to Hub." code="CORE_REPORT_JOBS_NOT_EXPOSED" /></div></section>
      <section className="aevo-platform-section" aria-labelledby="saved-reports-heading"><div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Saved definitions</span><h2 id="saved-reports-heading">Saved reports</h2><p>Definitions must be stored and permission-checked by Core.</p></div></div><CapabilityNotice state="unavailable" title="Saved reports unavailable" description="Core does not expose saved report definition metadata or read/write actions. Hub does not persist report definitions in browser storage." code="CORE_SAVED_REPORTS_NOT_EXPOSED" /></section>
    </PlatformPage>
  );
}
