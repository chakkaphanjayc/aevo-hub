import { Activity, Gauge, ShieldCheck } from "lucide-react";
import { ApiClientError } from "@aevocado/contracts";
import { Card, StatusBadge } from "@aevocado/design-system";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requestCsrfHeaders, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

type RankingMode = "SHADOW" | "LIVE";

interface RankingGuardrailReport {
  since: string;
  until: string;
  evaluationCount: number;
  personalizedEvaluationCount: number;
  shadowEvaluationCount: number;
  servedItemCount: number;
  creatorConcentration: number;
  categoryDiversity: number;
  hideRate: number;
  quickBackRate: number;
  averageLatencyMs: number;
  guardrails: Record<string, boolean>;
}

interface FeatureFlag {
  enabled: boolean;
  rolloutPercent: number;
  config: Record<string, unknown>;
}

interface RankingLoaderData {
  session: AdminLoaderData;
  report: RankingGuardrailReport | null;
  featureFlag: FeatureFlag | null;
  denied: boolean;
  canManage: boolean;
}

interface RankingActionData {
  ok: false;
  message: string;
}

function readMode(config: Record<string, unknown> | undefined): RankingMode {
  return config?.mode === "LIVE" ? "LIVE" : "SHADOW";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function metricTone(value: boolean): "success" | "danger" {
  return value ? "success" : "danger";
}

export async function loader({ request }: LoaderFunctionArgs): Promise<RankingLoaderData> {
  const session = await requireAdminAccess(request);
  const canRead = hasAdminPermission(session, "system.jobs");
  const canManage = hasAdminPermission(session, "go.settings.manage");
  if (!canRead) return { session, report: null, featureFlag: null, denied: true, canManage };

  const api = createAdminApiClient(request);
  const reportResponse = await api.request<{ success: true; report: RankingGuardrailReport }>("/api/v1/admin/tracedee/ranking/guardrails");
  let featureFlag: FeatureFlag | null = null;
  if (hasAdminPermission(session, "go.settings.read")) {
    const settingsResponse = await api.request<{ success: true; featureFlags: Record<string, FeatureFlag> }>("/api/v1/admin/go/settings");
    featureFlag = settingsResponse.featureFlags.taste_ranking_v1 ?? null;
  }
  return { session, report: reportResponse.report, featureFlag, denied: false, canManage };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response | RankingActionData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "go.settings.manage")) return { ok: false, message: "บัญชีนี้ไม่มีสิทธิ์ปรับ rollout ของ ranking" };

  const form = await request.formData();
  const mode = String(form.get("mode") ?? "SHADOW");
  const enabled = form.get("enabled") === "true";
  const rolloutPercent = Number.parseInt(String(form.get("rolloutPercent") ?? "0"), 10);
  const reason = String(form.get("reason") ?? "").trim();
  if (mode !== "SHADOW" && mode !== "LIVE") return { ok: false, message: "ranking mode ต้องเป็น SHADOW หรือ LIVE" };
  if (![0, 5, 25, 50, 100].includes(rolloutPercent)) return { ok: false, message: "rollout ต้องอยู่ในขั้น 0, 5, 25, 50 หรือ 100" };
  if (reason.length < 3) return { ok: false, message: "กรุณาระบุเหตุผลหรือ incident ticket อย่างน้อย 3 ตัวอักษร" };

  try {
    const api = createAdminApiClient(request);
    await api.requestJson<{ success: true }, { enabled: boolean; rolloutPercent: number; config: { mode: RankingMode }; reason: string }>("/api/v1/admin/go/feature-flags/taste_ranking_v1", {
      method: "PATCH",
      headers: requestCsrfHeaders(request),
      body: { enabled, rolloutPercent, config: { mode }, reason }
    });
    return redirect("/ranking");
  } catch (error) {
    return { ok: false, message: error instanceof ApiClientError ? error.message : "ไม่สามารถปรับ ranking rollout ได้" };
  }
}

function Guardrail({ label, value }: { label: string; value: boolean }) {
  return <span className={`admin-ranking-guardrail admin-ranking-guardrail--${value ? "pass" : "fail"}`}><span aria-hidden="true">{value ? "✓" : "!"}</span>{label}</span>;
}

export default function RankingRoute() {
  const data = useLoaderData() as RankingLoaderData;
  const actionData = useActionData() as RankingActionData | undefined;
  const navigation = useNavigation();
  if (data.denied || !data.report) return <Card className="admin-panel"><h1>TraceDee ranking</h1><p className="admin-muted">บัญชีนี้ไม่มีสิทธิ์อ่าน ranking guardrails</p></Card>;

  const mode = readMode(data.featureFlag?.config);
  const flagEnabled = data.featureFlag?.enabled ?? false;
  const rolloutPercent = data.featureFlag?.rolloutPercent ?? 0;
  const isBusy = navigation.state !== "idle";
  const guardrailReady = data.report.evaluationCount > 0 && Object.values(data.report.guardrails).length > 0 && Object.values(data.report.guardrails).every(Boolean);

  return (
    <>
      <section className="admin-page-heading">
        <div><span className="admin-eyebrow">TraceDee / measured rollout</span><h1>Taste ranking control</h1><p>ดูผล shadow/live ranking, guardrails และปรับ cohort rollout เป็นขั้นโดยทุกการเปลี่ยนแปลงผ่านสิทธิ์และ audit trail</p></div>
        <StatusBadge tone={mode === "LIVE" ? "warning" : "info"}>{mode} · {rolloutPercent}%</StatusBadge>
      </section>

      {actionData?.ok === false ? <p className="admin-inline-error" role="alert">{actionData.message}</p> : null}

      <section className="admin-section-grid">
        <Card className="admin-panel"><div className="admin-panel__heading"><div><span className="admin-eyebrow">Evaluation window</span><h2>{data.report.evaluationCount} evaluations</h2></div><Gauge size={20} aria-hidden="true" /></div><div className="admin-ranking-summary"><span><strong>{data.report.shadowEvaluationCount}</strong><small>shadow</small></span><span><strong>{data.report.personalizedEvaluationCount}</strong><small>personalized</small></span><span><strong>{data.report.servedItemCount}</strong><small>served items</small></span></div><p className="admin-muted">{new Date(data.report.since).toLocaleString("th-TH")} – {new Date(data.report.until).toLocaleString("th-TH")}</p></Card>
        <Card className="admin-panel"><div className="admin-panel__heading"><div><span className="admin-eyebrow">Release readiness</span><h2>{guardrailReady ? "Guardrails pass" : "ยังเก็บหลักฐานไม่พอ"}</h2></div><ShieldCheck size={20} aria-hidden="true" /></div><p className="admin-muted">{guardrailReady ? "พร้อมพิจารณา cohort ถัดไปตาม runbook" : "คง SHADOW หรือ rollout 0% จนกว่าจะมี evaluation และ guardrails ผ่าน"}</p><div className="admin-ranking-guardrails"><Guardrail label="Creator concentration" value={data.report.guardrails.creatorConcentrationPass === true} /><Guardrail label="Category diversity" value={data.report.guardrails.categoryDiversityPass === true} /><Guardrail label="Hide rate" value={data.report.guardrails.hideRatePass === true} /><Guardrail label="Quick-back rate" value={data.report.guardrails.quickBackRatePass === true} /><Guardrail label="Latency" value={data.report.guardrails.latencyPass === true} /></div></Card>
      </section>

      <Card className="admin-panel admin-ranking-card">
        <div className="admin-panel__heading"><div><span className="admin-eyebrow">Current signals</span><h2>Guardrail measurements</h2></div><Activity size={20} aria-hidden="true" /></div>
        <div className="admin-ranking-metrics"><span><strong>{percent(data.report.creatorConcentration)}</strong><small>creator concentration</small></span><span><strong>{data.report.categoryDiversity}</strong><small>topic categories</small></span><span><strong>{percent(data.report.hideRate)}</strong><small>hide / open</small></span><span><strong>{percent(data.report.quickBackRate)}</strong><small>quick-back / open</small></span><span><strong>{Math.round(data.report.averageLatencyMs)}ms</strong><small>average latency</small></span></div>
      </Card>

      <Card className="admin-panel admin-ranking-card">
        <div className="admin-panel__heading"><div><span className="admin-eyebrow">Controlled change</span><h2>Update taste_ranking_v1</h2></div><StatusBadge tone={flagEnabled ? "success" : "neutral"}>{flagEnabled ? "enabled" : "disabled"}</StatusBadge></div>
        {!data.featureFlag ? <p className="admin-muted">ไม่มีสิทธิ์อ่าน Go settings จึงยังไม่แสดง control ของ feature flag</p> : data.canManage ? <Form method="post" className="admin-ranking-form">
          <label><span>Mode</span><select name="mode" defaultValue={mode}><option value="SHADOW">SHADOW — วัดผล ไม่เปลี่ยนลำดับที่ serve</option><option value="LIVE">LIVE — personalized ordering ตาม cohort</option></select></label>
          <label><span>Rollout cohort</span><select name="rolloutPercent" defaultValue={String(rolloutPercent)}><option value="0">0% · kill switch</option><option value="5">5% · canary</option><option value="25">25%</option><option value="50">50%</option><option value="100">100%</option></select></label>
          <label className="admin-ranking-checkbox"><input type="checkbox" name="enabled" value="true" defaultChecked={flagEnabled} /><span>เปิด feature flag</span></label>
          <label className="admin-ranking-reason"><span>เหตุผล / incident ticket</span><input name="reason" minLength={3} maxLength={1000} required placeholder="เช่น TASTE-123 หลัง review guardrails 7 วัน" /></label>
          <div className="admin-ranking-form__footer"><p className="admin-muted">ลำดับที่ปลอดภัย: SHADOW → LIVE 5% → 25% → 50% → 100% · หาก guardrail fail ให้กลับ 0% และคง kill switch</p><button className="admin-moderation-action" type="submit" disabled={isBusy}>{isBusy ? "กำลังบันทึก…" : "บันทึก rollout"}</button></div>
        </Form> : <p className="admin-muted">บัญชีนี้อ่านได้อย่างเดียว ไม่มีสิทธิ์ go.settings.manage</p>}
      </Card>
    </>
  );
}
