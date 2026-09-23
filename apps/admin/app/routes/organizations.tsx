import { Building2 } from "lucide-react";
import { Card, DataTable, StatusBadge } from "@aevocado/design-system";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  maxUsers: number;
  maxStores: number;
  storesCount: number;
  membersCount: number;
  createdAt: string;
}

interface OrganizationsLoaderData {
  session: AdminLoaderData;
  organizations: AdminOrganization[];
  denied: boolean;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<OrganizationsLoaderData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "organization.read")) return { session, organizations: [], denied: true };
  const api = createAdminApiClient(request);
  const result = await api.request<{ success: true; organizations: AdminOrganization[] }>("/api/v1/admin/organizations");
  return { session, organizations: result.organizations, denied: false };
}

export default function OrganizationsRoute() {
  const data = useLoaderData() as OrganizationsLoaderData;
  if (data.denied) return <Card className="admin-panel"><h1>Organizations</h1><p className="admin-muted">บัญชีนี้ไม่มีสิทธิ์อ่านข้อมูลข้ามองค์กร</p></Card>;
  return (
    <>
      <section className="admin-page-heading"><div><span className="admin-eyebrow">Cross-tenant directory</span><h1>Organizations</h1><p>ข้อมูลนี้เป็น platform-level view สำหรับ support, operations และ governance เท่านั้น</p></div><StatusBadge tone="info">{data.organizations.length} tenants</StatusBadge></section>
      <Card className="admin-panel"><DataTable caption="Organization directory"><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Organization</th><th>Status</th><th>Stores</th><th>Members</th><th>Quotas</th><th>Created</th></tr></thead><tbody>{data.organizations.map((organization) => <tr key={organization.id}><td><div className="admin-table-primary"><span className="admin-application-icon"><Building2 size={15} aria-hidden="true" /></span><span><strong>{organization.name}</strong><small>{organization.slug}</small></span></div></td><td><StatusBadge tone={organization.status === "ACTIVE" ? "success" : "warning"}>{organization.status}</StatusBadge></td><td>{organization.storesCount} / {organization.maxStores}</td><td>{organization.membersCount} / {organization.maxUsers}</td><td><span className="admin-code">{organization.maxUsers} users · {organization.maxStores} stores</span></td><td>{new Date(organization.createdAt).toLocaleDateString("en-GB")}</td></tr>)}</tbody></table></div></DataTable></Card>
    </>
  );
}
