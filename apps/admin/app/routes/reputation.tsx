import { BadgeCheck, ChevronDown } from "lucide-react";
import { Card, StatusBadge } from "@aevocado/design-system";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { createAdminApiClient, requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

interface ReputationEvidence {
  profileId: string;
  profileName: string;
  scoreVersion: number;
  reputation: number;
  helpfulRatio: number;
  downstreamCompletionRate: number;
  ratingConfidence: number;
  reportOutcome: number;
  accountTrust: number;
  evidenceCount: number;
  components: Record<string, unknown>;
  calculatedAt: string;
}

interface ReputationLoaderData {
  session: AdminLoaderData;
  evidence: ReputationEvidence[];
  denied: boolean;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function scoreTone(value: number): "success" | "warning" | "danger" | "neutral" {
  if (value >= 60) return "success";
  if (value >= 25) return "warning";
  if (value < 0) return "danger";
  return "neutral";
}

export async function loader({ request }: LoaderFunctionArgs): Promise<ReputationLoaderData> {
  const session = await requireAdminAccess(request);
  if (!hasAdminPermission(session, "system.jobs")) return { session, evidence: [], denied: true };
  const api = createAdminApiClient(request);
  const result = await api.request<{ success: true; evidence: ReputationEvidence[] }>("/api/v1/admin/tracedee/reputation/evidence?limit=100");
  return { session, evidence: result.evidence, denied: false };
}

function EvidenceDetail({ item }: { item: ReputationEvidence }) {
  const inputs = item.components.inputs;
  const evidence = Array.isArray(item.components.evidence) ? item.components.evidence.filter((value): value is string => typeof value === "string") : [];
  return (
    <details className="admin-reputation-details">
      <summary><ChevronDown size={14} aria-hidden="true" />ดู inputs และเหตุผล</summary>
      <div className="admin-reputation-details__body">
        <div className="admin-reputation-evidence-list">{evidence.map((reason) => <span key={reason}>{reason}</span>)}</div>
        <pre>{JSON.stringify(inputs ?? {}, null, 2)}</pre>
      </div>
    </details>
  );
}

export default function ReputationRoute() {
  const data = useLoaderData() as ReputationLoaderData;
  if (data.denied) return <Card className="admin-panel"><h1>TraceDee reputation</h1><p className="admin-muted">บัญชีนี้ไม่มีสิทธิ์อ่าน evidence ของ recognition projection</p></Card>;

  return (
    <>
      <section className="admin-page-heading">
        <div><span className="admin-eyebrow">Recognition / evidence</span><h1>Reputation evidence</h1><p>ดูองค์ประกอบที่ทำให้ reputation เปลี่ยนโดยไม่เปิดสูตรต่อผู้ใช้ปลายทาง ทุกแถวผูกกับ score version และ rebuild timestamp</p></div>
        <StatusBadge tone="info">{data.evidence.length} profiles</StatusBadge>
      </section>
      {data.evidence.length === 0 ? <Card className="admin-panel admin-state"><BadgeCheck size={22} aria-hidden="true" /><h2>ยังไม่มี reputation evidence</h2><p className="admin-muted">เรียก worker projection rebuild เพื่อสร้าง snapshot ชุดแรก</p></Card> : <div className="admin-reputation-list">
        {data.evidence.map((item) => <Card className="admin-panel admin-reputation-card" key={`${item.profileId}:${item.scoreVersion}`}>
          <div className="admin-reputation-card__header"><div className="admin-table-primary"><span className="admin-application-icon"><BadgeCheck size={15} aria-hidden="true" /></span><span><strong>{item.profileName}</strong><small>{item.profileId} · score v{item.scoreVersion}</small></span></div><StatusBadge tone={scoreTone(item.reputation)}>reputation {item.reputation.toFixed(2)}</StatusBadge></div>
          <div className="admin-reputation-metrics"><span><strong>{percent(item.helpfulRatio)}</strong><small>helpful ratio</small></span><span><strong>{percent(item.downstreamCompletionRate)}</strong><small>downstream completion</small></span><span><strong>{percent(item.ratingConfidence)}</strong><small>rating confidence</small></span><span><strong>{item.reportOutcome.toFixed(2)}</strong><small>report outcome</small></span><span><strong>{percent(item.accountTrust)}</strong><small>account trust</small></span></div>
          <p className="admin-muted">หลักฐาน {item.evidenceCount} รายการ · คำนวณเมื่อ {new Date(item.calculatedAt).toLocaleString("th-TH")}</p>
          <EvidenceDetail item={item} />
        </Card>)}
      </div>}
    </>
  );
}
