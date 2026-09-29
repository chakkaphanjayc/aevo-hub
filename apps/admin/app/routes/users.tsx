import { Users } from "lucide-react";
import { Card, DataTable, StatusBadge } from "@aevocado/design-system";
import { ApiClientError } from "@aevocado/contracts";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  memberships: Array<{ organizationName: string; role: string }>;
}

interface UsersLoaderData {
  session: AdminLoaderData;
  users: AdminUser[];
  denied: boolean;
  available: boolean;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<UsersLoaderData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "organization.read")) return { session, users: [], denied: true, available: false };
  const api = createAdminApiClient(request);
  try {
    const result = await api.request<{ success: true; users: AdminUser[] }>("/api/v1/admin/users");
    return { session, users: result.users, denied: false, available: true };
  } catch (error) {
    if (!(error instanceof ApiClientError)) throw error;
    return { session, users: [], denied: false, available: false };
  }
}

export default function UsersRoute() {
  const data = useLoaderData() as UsersLoaderData;
  if (data.denied) return <Card className="admin-panel"><h1>Users & access</h1><p className="admin-muted">บัญชีนี้ไม่มีสิทธิ์อ่าน user directory</p></Card>;
  if (!data.available) return <Card className="admin-panel"><div className="admin-panel__heading"><div><span className="admin-eyebrow">Identity directory</span><h1>Users & access</h1></div><StatusBadge tone="warning">Not available</StatusBadge></div><p className="admin-muted">Core API ยังไม่มี directory contract สำหรับข้อมูล users ใน local environment นี้ จึงยังแสดงรายการ identity ข้ามองค์กรไม่ได้</p></Card>;
  return (
    <>
      <section className="admin-page-heading"><div><span className="admin-eyebrow">Identity directory</span><h1>Users & access</h1><p>ตรวจ identity และ organization membership โดยไม่ยกระดับ owner ให้เป็น platform administrator</p></div><StatusBadge tone="info">{data.users.length} users</StatusBadge></section>
      <Card className="admin-panel"><DataTable caption="User directory"><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>User</th><th>Status</th><th>Organizations</th><th>Roles</th></tr></thead><tbody>{data.users.map((user) => <tr key={user.id}><td><div className="admin-table-primary"><span className="admin-application-icon"><Users size={15} aria-hidden="true" /></span><span><strong>{user.displayName || user.email}</strong><small>{user.email}</small></span></div></td><td><StatusBadge tone={user.status === "ACTIVE" ? "success" : "danger"}>{user.status}</StatusBadge></td><td>{user.memberships.length || "—"}</td><td><div className="admin-tag-list">{user.memberships.length ? user.memberships.map((membership) => <span className="admin-tag" key={`${user.id}-${membership.organizationName}-${membership.role}`}>{membership.organizationName} · {membership.role}</span>) : <span className="admin-muted">No memberships</span>}</div></td></tr>)}</tbody></table></div></DataTable></Card>
    </>
  );
}
