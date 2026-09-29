import { CreditCard } from "lucide-react";
import { Card, DataTable, StatusBadge } from "@aevocado/design-system";
import { ApiClientError } from "@aevocado/contracts";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

interface AdminSubscription {
  id: string;
  organizationId: string;
  organizationName: string;
  planId: string;
  provider: string;
  status: string;
  currentPeriodEnd?: string | null;
}

interface SubscriptionsLoaderData {
  session: AdminLoaderData;
  subscriptions: AdminSubscription[];
  denied: boolean;
  available: boolean;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<SubscriptionsLoaderData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "subscription.read")) return { session, subscriptions: [], denied: true, available: false };
  const api = createAdminApiClient(request);
  try {
    const result = await api.request<{ success: true; subscriptions: AdminSubscription[] }>("/api/v1/admin/subscriptions");
    return { session, subscriptions: result.subscriptions, denied: false, available: true };
  } catch (error) {
    if (!(error instanceof ApiClientError)) throw error;
    return { session, subscriptions: [], denied: false, available: false };
  }
}

export default function SubscriptionsRoute() {
  const data = useLoaderData() as SubscriptionsLoaderData;
  if (data.denied) return <Card className="admin-panel"><h1>Subscriptions</h1><p className="admin-muted">บัญชีนี้ไม่มีสิทธิ์อ่าน billing records</p></Card>;
  if (!data.available) return <Card className="admin-panel"><div className="admin-panel__heading"><div><span className="admin-eyebrow">Billing source of truth</span><h1>Subscriptions</h1></div><StatusBadge tone="warning">Not available</StatusBadge></div><p className="admin-muted">Core API ยังไม่มี billing directory contract สำหรับ local environment นี้ จึงยังแสดงรายการ subscription ไม่ได้</p></Card>;
  return (
    <>
      <section className="admin-page-heading"><div><span className="admin-eyebrow">Billing source of truth</span><h1>Subscriptions</h1><p>ตรวจ plan และ lifecycle จากข้อมูลที่ถูก sync โดย webhook ไม่ใช่ค่าที่ client รายงาน</p></div><StatusBadge tone="info">{data.subscriptions.length} records</StatusBadge></section>
      <Card className="admin-panel"><DataTable caption="Subscription directory"><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Organization</th><th>Plan</th><th>Provider</th><th>Status</th><th>Period end</th></tr></thead><tbody>{data.subscriptions.map((subscription) => <tr key={subscription.id}><td><div className="admin-table-primary"><span className="admin-application-icon"><CreditCard size={15} aria-hidden="true" /></span><span><strong>{subscription.organizationName}</strong><small>{subscription.organizationId}</small></span></div></td><td><span className="admin-code">{subscription.planId}</span></td><td>{subscription.provider}</td><td><StatusBadge tone={subscription.status === "ACTIVE" ? "success" : "warning"}>{subscription.status}</StatusBadge></td><td>{subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString("en-GB") : "—"}</td></tr>)}</tbody></table></div></DataTable></Card>
    </>
  );
}
