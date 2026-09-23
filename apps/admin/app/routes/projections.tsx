import { BarChart3, RotateCcw } from "lucide-react";
import { ApiClientError } from "@aevocado/contracts";
import { Card, StatusBadge } from "@aevocado/design-system";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requestCsrfHeaders, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

type ProjectionStatus = "APPLYING" | "APPLIED" | "ROLLED_BACK" | "FAILED";

interface ProjectionRun {
  runId: string;
  scoreVersion: number;
  status: ProjectionStatus;
  reason: string;
  profileCount: number;
  expertiseCount: number;
  tasteCount: number;
  qualityCount: number;
  failureReason: string;
  rollbackReason: string;
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
}

interface ProjectionLoaderData {
  session: AdminLoaderData;
  runs: ProjectionRun[];
  denied: boolean;
}

interface ProjectionActionData {
  ok: false;
  message: string;
}

function statusTone(status: ProjectionStatus): "success" | "warning" | "danger" | "neutral" {
  if (status === "APPLIED") return "success";
  if (status === "APPLYING") return "warning";
  if (status === "FAILED") return "danger";
  return "neutral";
}

export async function loader({ request }: LoaderFunctionArgs): Promise<ProjectionLoaderData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "system.jobs")) return { session, runs: [], denied: true };
  const api = createAdminApiClient(request);
  const result = await api.request<{ success: true; runs: ProjectionRun[] }>("/api/v1/admin/tracedee/projections/runs?limit=30");
  return { session, runs: result.runs, denied: false };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response | ProjectionActionData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "system.jobs")) return { ok: false, message: "บัญชีนี้ไม่มีสิทธิ์ rollback projection" };
  const form = await request.formData();
  const runId = String(form.get("runId") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/iu.test(runId)) return { ok: false, message: "projection run ไม่ถูกต้อง" };
  if (reason.length < 3) return { ok: false, message: "กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร" };
  try {
    const api = createAdminApiClient(request);
    await api.requestJson<{ success: true }, { reason: string }>(`/api/v1/admin/tracedee/projections/runs/${runId}/rollback`, {
      method: "POST",
      headers: requestCsrfHeaders(request),
      idempotencyKey: `tracedee-projection-rollback-${runId}-${Date.now()}`,
      body: { reason }
    });
    return redirect("/projections");
  } catch (error) {
    return { ok: false, message: error instanceof ApiClientError ? error.message : "ไม่สามารถ rollback projection ได้" };
  }
}

export default function ProjectionsRoute() {
  const data = useLoaderData() as ProjectionLoaderData;
  const actionData = useActionData() as ProjectionActionData | undefined;
  const navigation = useNavigation();
  if (data.denied) return <Card className="admin-panel"><h1>TraceDee scoring</h1><p className="admin-muted">บัญชีนี้ไม่มีสิทธิ์อ่านหรือ rollback projection</p></Card>;

  return (
    <>
      <section className="admin-page-heading"><div><span className="admin-eyebrow">Recognition / replay</span><h1>Score projections</h1><p>ตรวจ versioned rebuild run และ rollback ไปยัง snapshot ก่อนหน้าได้เมื่อ event ถูก invalidate โดยทุกคำสั่งต้องมีเหตุผลและ audit trail</p></div><StatusBadge tone="info">{data.runs.length} runs</StatusBadge></section>
      {actionData?.ok === false ? <p className="admin-inline-error" role="alert">{actionData.message}</p> : null}
      {data.runs.length === 0 ? <Card className="admin-panel admin-state"><BarChart3 size={22} aria-hidden="true" /><h2>ยังไม่มี projection run</h2><p className="admin-muted">Worker จะสร้าง run เมื่อ reconciliation ทำงาน</p></Card> : <div className="admin-projection-list">
        {data.runs.map((run) => <Card className="admin-panel admin-projection-card" key={run.runId}>
          <div className="admin-projection-card__header"><div className="admin-table-primary"><span className="admin-application-icon"><BarChart3 size={15} aria-hidden="true" /></span><span><strong>Score version {run.scoreVersion}</strong><small>{run.runId}</small></span></div><StatusBadge tone={statusTone(run.status)}>{run.status}</StatusBadge></div>
          <div className="admin-projection-card__meta"><span>เหตุผล: <strong>{run.reason}</strong></span><span>Profiles {run.profileCount}</span><span>Expertise {run.expertiseCount}</span><span>Taste {run.tasteCount}</span><span>Quality {run.qualityCount}</span></div>
          <p className="admin-muted">สร้างเมื่อ {new Date(run.createdAt).toLocaleString("th-TH")}{run.rolledBackAt ? ` · rollback เมื่อ ${new Date(run.rolledBackAt).toLocaleString("th-TH")}` : ""}</p>
          {run.failureReason ? <p className="admin-inline-error">{run.failureReason}</p> : null}
          {run.status === "APPLIED" ? <Form method="post" className="admin-projection-rollback"><input type="hidden" name="runId" value={run.runId} /><input name="reason" minLength={3} maxLength={1000} required placeholder="เหตุผล / incident ticket สำหรับ rollback" disabled={navigation.state !== "idle"} /><button className="admin-moderation-action admin-moderation-action--danger" type="submit" disabled={navigation.state !== "idle"}><RotateCcw size={14} aria-hidden="true" />{navigation.state !== "idle" ? "กำลัง rollback…" : "Rollback snapshot"}</button></Form> : null}
        </Card>)}
      </div>}
    </>
  );
}
