import { useEffect, useRef, useState } from "react";
import { Boxes } from "lucide-react";
import { ApiClientError } from "@aevocado/contracts";
import { isApplicationCode, type ApplicationCode } from "@aevocado/api-contract";
import { Card, DataTable, Input, StatusBadge } from "@aevocado/design-system";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requestCsrfHeaders, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

interface AdminApplication {
  code: ApplicationCode;
  name: string;
  kind: string;
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  updatedAt: string;
}

interface ApplicationsLoaderData {
  session: AdminLoaderData;
  applications: AdminApplication[];
  denied: boolean;
}

interface ApplicationsActionData {
  ok: false;
  message: string;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<ApplicationsLoaderData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "system.health")) return { session, applications: [], denied: true };
  const api = createAdminApiClient(request);
  const result = await api.request<{ success: true; applications: AdminApplication[] }>("/api/v1/admin/applications");
  return { session, applications: result.applications, denied: false };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response | ApplicationsActionData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "system.jobs")) return { ok: false, message: "บัญชีนี้ไม่มีสิทธิ์ควบคุมสถานะ application" };

  const form = await request.formData();
  const code = String(form.get("code") ?? "").toUpperCase();
  const status = String(form.get("status") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  if (!isApplicationCode(code)) return { ok: false, message: "ไม่พบ application code ที่ถูกต้อง" };
  if (status !== "ACTIVE" && status !== "DISABLED") return { ok: false, message: "สถานะ application ไม่ถูกต้อง" };
  if (reason.length < 3) return { ok: false, message: "กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร" };

  try {
    const api = createAdminApiClient(request);
    await api.requestJson<{ success: true }, { status: "ACTIVE" | "DISABLED"; reason: string }>(`/api/v1/admin/applications/${encodeURIComponent(code)}`, {
      method: "PATCH",
      headers: requestCsrfHeaders(request),
      body: { status, reason }
    });
    return redirect("/applications");
  } catch (error) {
    return { ok: false, message: error instanceof ApiClientError ? error.message : "ไม่สามารถเปลี่ยนสถานะ application ได้" };
  }
}

function HoldSubmitButton({ label, danger, disabled }: { label: string; danger: boolean; disabled: boolean }) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const startedAt = useRef<number | null>(null);
  const interval = useRef<number | null>(null);

  function clearHold(): void {
    if (interval.current !== null) window.clearInterval(interval.current);
    interval.current = null;
    startedAt.current = null;
    setHolding(false);
    setProgress(0);
  }

  function startHold(form: HTMLFormElement | null): void {
    if (disabled || holding) return;
    setHolding(true);
    startedAt.current = performance.now();
    interval.current = window.setInterval(() => {
      const started = startedAt.current ?? performance.now();
      const next = Math.min((performance.now() - started) / 900, 1);
      setProgress(next);
      if (next >= 1) {
        clearHold();
        form?.requestSubmit();
      }
    }, 16);
  }

  useEffect(() => () => clearHold(), []);

  return (
    <button
      className={`admin-hold-button${danger ? " admin-hold-button--danger" : ""}`}
      type="button"
      disabled={disabled}
      aria-label={`Hold to ${label.toLowerCase()}`}
      aria-busy={holding}
      onPointerDown={(event) => startHold(event.currentTarget.form)}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onPointerLeave={clearHold}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !holding) {
          event.preventDefault();
          startHold(event.currentTarget.form);
        }
      }}
      onKeyUp={(event) => {
        if (event.key === "Enter" || event.key === " ") clearHold();
      }}
    >
      <span className="admin-hold-button__progress" style={{ width: `${progress * 100}%` }} aria-hidden="true" />
      <span>{holding ? "ปล่อยเมื่อพร้อม…" : `กดค้างเพื่อ${label}`}</span>
    </button>
  );
}

export default function ApplicationsRoute() {
  const data = useLoaderData() as ApplicationsLoaderData;
  const actionData = useActionData() as ApplicationsActionData | undefined;
  const navigation = useNavigation();

  if (data.denied) {
    return <Card className="admin-panel"><h1>Application registry</h1><p className="admin-muted">บัญชีนี้มีสิทธิ์เข้า Aevo Admin แต่ไม่มีสิทธิ์อ่าน application registry</p></Card>;
  }

  return (
    <>
      <section className="admin-page-heading">
        <div><span className="admin-eyebrow">Control plane</span><h1>Applications</h1><p>สถานะของ first-party application boundary ทั้งหมดใน Aevo Ecosystem การปิดแอปเป็น privileged action และจะถูกบันทึก audit ทุกครั้ง</p></div>
        <StatusBadge tone="info">{data.applications.length} registered</StatusBadge>
      </section>
      {actionData?.ok === false ? <p className="admin-inline-error" role="alert">{actionData.message}</p> : null}
      <Card className="admin-panel">
        <DataTable caption="Application registry">
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead><tr><th>Application</th><th>Boundary</th><th>Status</th><th>Reason</th><th>Control</th></tr></thead>
              <tbody>
                {data.applications.map((application) => {
                  const nextStatus = application.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
                  const isAdmin = application.code === "ADMIN";
                  return (
                    <tr key={application.code}>
                      <td><div className="admin-table-primary"><span className="admin-application-icon"><Boxes size={15} aria-hidden="true" /></span><span><strong>{application.name}</strong><small>{application.code}</small></span></div></td>
                      <td><span className="admin-code">{application.kind}</span></td>
                      <td><StatusBadge tone={application.status === "ACTIVE" ? "success" : "danger"}>{application.status}</StatusBadge></td>
                      <td><Input name="reason" form={`application-${application.code}`} placeholder="เหตุผล / ticket" maxLength={500} required aria-label={`Reason for ${application.name}`} disabled={isAdmin || navigation.state !== "idle"} /></td>
                      <td>
                        <Form id={`application-${application.code}`} method="post" className="admin-inline-form">
                          <input type="hidden" name="code" value={application.code} />
                          <input type="hidden" name="status" value={nextStatus} />
                          <HoldSubmitButton label={nextStatus === "ACTIVE" ? "เปิดใช้งาน" : "ปิดใช้งาน"} danger={nextStatus === "DISABLED"} disabled={isAdmin || navigation.state !== "idle"} />
                        </Form>
                        {isAdmin ? <small className="admin-muted">Admin boundary protected</small> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DataTable>
      </Card>
    </>
  );
}
