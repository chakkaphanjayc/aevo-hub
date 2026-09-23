import { Activity, Boxes, Building2, CreditCard, Users } from "lucide-react";
import { Card, StatusBadge } from "@aevocado/design-system";
import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { ApiClientError } from "@aevocado/contracts";
import { createAdminApiClient, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

interface PlatformOverview {
  totalOrganizations: number;
  totalStores: number;
  totalUsers: number;
  totalDevices: number;
  totalSubscriptions: number;
  operatingMode: { mode: string; unlimited: boolean };
}

interface AdminApplication {
  code: string;
  name: string;
  kind: string;
  status: "ACTIVE" | "DISABLED";
}

interface DashboardLoaderData {
  session: AdminLoaderData;
  overview: PlatformOverview;
  applications: AdminApplication[];
}

export async function loader({ request }: LoaderFunctionArgs): Promise<DashboardLoaderData> {
  const session = await requireAdminAccess(request);
  const api = createAdminApiClient(request);
  const overviewResult = await api.request<{ success: true } & PlatformOverview>("/api/v1/admin/overview");
  let applications: AdminApplication[] = [];
  if (hasAdminPermission(session, "system.health")) {
    try {
      const result = await api.request<{ success: true; applications: AdminApplication[] }>("/api/v1/admin/applications");
      applications = result.applications;
    } catch (error) {
      if (!(error instanceof ApiClientError)) throw error;
    }
  }
  return { session, overview: overviewResult, applications };
}

const quickLinks = [
  { to: "/applications", title: "Applications", description: "ตรวจสถานะและควบคุม application registry", icon: Boxes },
  { to: "/organizations", title: "Organizations", description: "ดู tenant, stores, quota และสถานะการใช้งาน", icon: Building2 },
  { to: "/subscriptions", title: "Subscriptions", description: "ตรวจ plan, billing provider และ entitlement source", icon: CreditCard },
  { to: "/users", title: "Users & access", description: "ตรวจบัญชี, membership และการเข้าถึงของผู้ใช้", icon: Users }
] as const;

function number(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export default function DashboardRoute() {
  const data = useLoaderData() as DashboardLoaderData;
  const { overview } = data;

  return (
    <>
      <section className="admin-page-heading">
        <div>
          <StatusBadge tone="success">Platform access verified</StatusBadge>
          <h1>Good morning, {data.session.me.user.displayName || data.session.me.user.email}</h1>
          <p>Aevo Admin คือ control plane สำหรับดูแล application boundary, organization lifecycle, billing และระบบปฏิบัติการของ Aevo Ecosystem</p>
        </div>
        <span className="admin-page-heading__code">ADMIN / {data.session.access.platformRole ?? "PLATFORM"}</span>
      </section>

      <section className="admin-kpi-grid" aria-label="Platform overview">
        <Card className="admin-kpi"><span>Organizations</span><strong>{number(overview.totalOrganizations)}</strong><small>Tenant boundaries</small></Card>
        <Card className="admin-kpi"><span>Stores</span><strong>{number(overview.totalStores)}</strong><small>Operational locations</small></Card>
        <Card className="admin-kpi"><span>Users</span><strong>{number(overview.totalUsers)}</strong><small>Platform identities</small></Card>
        <Card className="admin-kpi"><span>Devices</span><strong>{number(overview.totalDevices)}</strong><small>Registered terminals</small></Card>
        <Card className="admin-kpi"><span>Subscriptions</span><strong>{number(overview.totalSubscriptions)}</strong><small>Billing records</small></Card>
      </section>

      <section className="admin-section-grid">
        <Card className="admin-panel admin-panel--wide">
          <div className="admin-panel__heading">
            <div><span className="admin-eyebrow">Runtime posture</span><h2>System operating mode</h2></div>
            <StatusBadge tone={overview.operatingMode.mode === "production" ? "success" : "warning"}>{overview.operatingMode.mode}</StatusBadge>
          </div>
          <p className="admin-muted">สถานะนี้ถูกอ่านจาก Core API และไม่สามารถเปลี่ยนจาก client โดยตรง การเปลี่ยนค่าระบบสำคัญต้องผ่าน permission และ audit trail</p>
          <div className="admin-inline-metrics"><span><Activity size={15} aria-hidden="true" /> {overview.operatingMode.unlimited ? "Unlimited mode enabled" : "Quota enforcement enabled"}</span><Link className="aevo-button aevo-button--secondary" to="/system">Open system health</Link></div>
        </Card>
        <Card className="admin-panel">
          <div className="admin-panel__heading"><div><span className="admin-eyebrow">Application boundary</span><h2>Connected applications</h2></div><Link className="admin-text-link" to="/applications">Manage</Link></div>
          <div className="admin-application-list">
            {data.applications.length > 0 ? data.applications.map((application) => (
              <div className="admin-application-row" key={application.code}>
                <span className="admin-application-icon"><Boxes size={15} aria-hidden="true" /></span>
                <span><strong>{application.name}</strong><small>{application.code} · {application.kind}</small></span>
                <StatusBadge tone={application.status === "ACTIVE" ? "success" : "danger"}>{application.status}</StatusBadge>
              </div>
            )) : <p className="admin-muted">ยังไม่มี application registry ที่อ่านได้</p>}
          </div>
        </Card>
      </section>

      <section className="admin-module-grid" aria-label="Control modules">
        {quickLinks.map(({ to, title, description, icon: Icon }) => (
          <Card className="admin-module-card" key={to}>
            <Icon size={20} aria-hidden="true" />
            <h2>{title}</h2>
            <p>{description}</p>
            <Link className="aevo-button aevo-button--secondary" to={to}>เปิด module</Link>
          </Card>
        ))}
      </section>
    </>
  );
}
