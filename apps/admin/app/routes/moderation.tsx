import { Flag, ShieldCheck } from "lucide-react";
import { ApiClientError } from "@aevocado/contracts";
import { Card, StatusBadge } from "@aevocado/design-system";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requestCsrfHeaders, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

type ModerationStatus = "OPEN" | "REVIEWING" | "RESOLVED" | "DISMISSED";
type ModerationAction = "REVIEW" | "LIMIT" | "REMOVE" | "RESTORE" | "DISMISS";

interface ModerationReport {
  reportId: string;
  entityType: "TRACE" | "PLACE" | "POST" | "COMMENT" | "PROFILE";
  entityId: string;
  reporterId: string;
  reporterName: string;
  reason: string;
  details: string;
  reportStatus: ModerationStatus;
  evidenceSnapshot: Record<string, unknown>;
  currentSnapshot: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: string | null;
  resolutionCode: ModerationAction | null;
  resolutionNote: string;
  createdAt: string;
}

interface ModerationLoaderData {
  session: AdminLoaderData;
  reports: ModerationReport[];
  status: ModerationStatus;
  denied: boolean;
}

interface ModerationActionData {
  ok: false;
  message: string;
}

const statusLabels: Record<ModerationStatus, string> = {
  OPEN: "เปิดอยู่",
  REVIEWING: "กำลังตรวจสอบ",
  RESOLVED: "จัดการแล้ว",
  DISMISSED: "ยกเลิกการรายงาน"
};

function statusTone(status: ModerationStatus): "danger" | "warning" | "success" | "neutral" {
  if (status === "OPEN") return "danger";
  if (status === "REVIEWING") return "warning";
  if (status === "RESOLVED") return "success";
  return "neutral";
}

function snapshotText(snapshot: Record<string, unknown>, key: string): string {
  const value = snapshot[key];
  return typeof value === "string" ? value : value === undefined || value === null ? "—" : JSON.stringify(value);
}

export async function loader({ request }: LoaderFunctionArgs): Promise<ModerationLoaderData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "content.moderate")) {
    return { session, reports: [], status: "OPEN", denied: true };
  }
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status: ModerationStatus = rawStatus === "REVIEWING" || rawStatus === "RESOLVED" || rawStatus === "DISMISSED" ? rawStatus : "OPEN";
  const api = createAdminApiClient(request);
  const result = await api.request<{ success: true; reports: ModerationReport[] }>(`/api/v1/admin/tracedee/moderation?status=${status}&limit=50`);
  return { session, reports: result.reports, status, denied: false };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response | ModerationActionData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "content.moderate")) return { ok: false, message: "บัญชีนี้ไม่มีสิทธิ์จัดการ TraceDee moderation" };

  const form = await request.formData();
  const reportId = String(form.get("reportId") ?? "");
  const actionName = String(form.get("action") ?? "").toUpperCase() as ModerationAction;
  const reason = String(form.get("reason") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/iu.test(reportId)) return { ok: false, message: "รายงานนี้ไม่ถูกต้อง" };
  if (!["REVIEW", "LIMIT", "REMOVE", "RESTORE", "DISMISS"].includes(actionName)) return { ok: false, message: "คำสั่ง moderation ไม่ถูกต้อง" };
  if (reason.length < 3) return { ok: false, message: "กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร" };

  try {
    const api = createAdminApiClient(request);
    await api.requestJson<{ success: true }, { action: ModerationAction; reason: string }>(`/api/v1/admin/tracedee/moderation/${reportId}/actions`, {
      method: "POST",
      headers: requestCsrfHeaders(request),
      idempotencyKey: `tracedee-moderation-${reportId}-${actionName}-${Date.now()}`,
      body: { action: actionName, reason }
    });
    const status = String(form.get("returnStatus") ?? "OPEN");
    return redirect(`/moderation?status=${encodeURIComponent(status)}`);
  } catch (error) {
    return { ok: false, message: error instanceof ApiClientError ? error.message : "ไม่สามารถจัดการรายงานนี้ได้" };
  }
}

function ModerationActionForm({ report, action, label, danger, currentStatus }: { report: ModerationReport; action: ModerationAction; label: string; danger?: boolean; currentStatus: ModerationStatus }) {
  const navigation = useNavigation();
  const isBusy = navigation.state !== "idle";
  return (
    <Form method="post" className="admin-moderation-action-form">
      <input type="hidden" name="reportId" value={report.reportId} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="returnStatus" value={currentStatus} />
      <input name="reason" placeholder="เหตุผล / ticket" maxLength={1000} required aria-label={`เหตุผลสำหรับ ${label}`} disabled={isBusy} />
      <button className={`admin-moderation-action${danger ? " admin-moderation-action--danger" : ""}`} type="submit" disabled={isBusy}>{isBusy ? "กำลังบันทึก…" : label}</button>
    </Form>
  );
}

export default function ModerationRoute() {
  const data = useLoaderData() as ModerationLoaderData;
  const actionData = useActionData() as ModerationActionData | undefined;

  if (data.denied) {
    return <Card className="admin-panel"><h1>TraceDee moderation</h1><p className="admin-muted">บัญชีนี้เข้า Aevo Admin ได้ แต่ไม่มีสิทธิ์จัดการ content moderation</p></Card>;
  }

  return (
    <>
      <section className="admin-page-heading">
        <div><span className="admin-eyebrow">TraceDee safety</span><h1>Moderation queue</h1><p>ตรวจหลักฐาน snapshot ก่อนตัดสินใจ จำกัดการมองเห็น ลบ กู้คืน หรือปิดรายงาน ทุก action จะถูกบันทึก audit และ outbox</p></div>
        <StatusBadge tone={data.status === "OPEN" ? "danger" : "info"}>{data.reports.length} {statusLabels[data.status]}</StatusBadge>
      </section>
      {actionData?.ok === false ? <p className="admin-inline-error" role="alert">{actionData.message}</p> : null}
      <nav className="admin-filter-nav" aria-label="สถานะ moderation">
        {(["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"] as const).map((status) => <a className={status === data.status ? "is-active" : ""} href={`/moderation?status=${status}`} key={status}>{statusLabels[status]}</a>)}
      </nav>
      {data.reports.length === 0 ? <Card className="admin-panel admin-state"><ShieldCheck size={22} aria-hidden="true" /><h2>ไม่มีรายงานในสถานะนี้</h2><p className="admin-muted">Queue ว่างอยู่ในขณะนี้ หรือเลือกสถานะอื่นเพื่อดู audit trail</p></Card> : <div className="admin-moderation-list">
        {data.reports.map((report) => <Card className="admin-panel admin-moderation-card" key={report.reportId}>
          <div className="admin-moderation-card__header"><div className="admin-table-primary"><span className="admin-application-icon"><Flag size={15} aria-hidden="true" /></span><span><strong>{report.entityType}</strong><small>{report.entityId}</small></span></div><StatusBadge tone={statusTone(report.reportStatus)}>{statusLabels[report.reportStatus]}</StatusBadge></div>
          <div className="admin-moderation-card__grid"><div><span className="admin-eyebrow">Report</span><strong>{report.reason}</strong><p>{report.details || "ไม่มีรายละเอียดเพิ่มเติม"}</p><small className="admin-muted">โดย {report.reporterName} · {new Date(report.createdAt).toLocaleString("th-TH")}</small></div><div><span className="admin-eyebrow">Current content</span><strong>{snapshotText(report.currentSnapshot, "title") || snapshotText(report.currentSnapshot, "name") || snapshotText(report.currentSnapshot, "body")}</strong><p>สถานะ: {snapshotText(report.currentSnapshot, "moderationStatus") !== "—" ? snapshotText(report.currentSnapshot, "moderationStatus") : snapshotText(report.currentSnapshot, "status")}</p><details><summary>ดู evidence snapshot</summary><pre>{JSON.stringify(report.evidenceSnapshot, null, 2)}</pre></details></div></div>
          {report.reportStatus === "OPEN" || report.reportStatus === "REVIEWING" ? <div className="admin-moderation-actions"><ModerationActionForm report={report} action="REVIEW" label="ย้ายเป็นกำลังตรวจสอบ" currentStatus={data.status} /><ModerationActionForm report={report} action="LIMIT" label="จำกัดการมองเห็น" currentStatus={data.status} /><ModerationActionForm report={report} action="REMOVE" label="ลบออกจาก public" danger currentStatus={data.status} /><ModerationActionForm report={report} action="DISMISS" label="ปิดรายงาน" currentStatus={data.status} /></div> : <div className="admin-moderation-actions"><ModerationActionForm report={report} action="RESTORE" label="กู้คืน content" currentStatus={data.status} /></div>}
        </Card>)}
      </div>}
    </>
  );
}
