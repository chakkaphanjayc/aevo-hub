import { Activity } from "lucide-react";
import { Card, StatusBadge } from "@aevocado/design-system";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

interface SystemLoaderData {
  session: AdminLoaderData;
  overview: { operatingMode: { mode: string; unlimited: boolean }; totalDevices: number } | null;
  denied: boolean;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<SystemLoaderData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "system.health")) return { session, overview: null, denied: true };
  const api = createAdminApiClient(request);
  const result = await api.request<{ operatingMode: { mode: string; unlimited: boolean }; totalDevices: number } & { success: true }>("/api/v1/admin/overview");
  return { session, overview: result, denied: false };
}

export default function SystemRoute() {
  const data = useLoaderData() as SystemLoaderData;
  if (data.denied || !data.overview) return <Card className="admin-panel"><h1>System health</h1><p className="admin-muted">บัญชีนี้ไม่มีสิทธิ์อ่าน system health</p></Card>;
  return (
    <>
      <section className="admin-page-heading"><div><span className="admin-eyebrow">Platform operations</span><h1>System health</h1><p>ภาพรวม runtime และ guardrails ของ Core API ที่แอปอื่นทั้งหมดใช้งานร่วมกัน</p></div><StatusBadge tone="success">Gateway reachable</StatusBadge></section>
      <section className="admin-section-grid"><Card className="admin-panel"><div className="admin-panel__heading"><div><span className="admin-eyebrow">Operating mode</span><h2>Runtime policy</h2></div><Activity size={20} aria-hidden="true" /></div><div className="admin-system-value"><strong>{data.overview.operatingMode.mode}</strong><span>{data.overview.operatingMode.unlimited ? "Unlimited quota mode" : "Quota enforcement active"}</span></div></Card><Card className="admin-panel"><span className="admin-eyebrow">Registered hardware</span><h2>{data.overview.totalDevices}</h2><p className="admin-muted">อุปกรณ์ที่อยู่ใน platform registry และอยู่ภายใต้ device boundary</p></Card></section>
    </>
  );
}
