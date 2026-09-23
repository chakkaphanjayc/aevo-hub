import type { OnboardingSessionSummary } from "@aevo/contracts";
import { ApiClientError } from "@aevocado/contracts";
import type { AuthenticatedMeResponse } from "@aevocado/api-contract";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  createHubApiClient,
  requestCsrfHeaders,
  requireAuthenticated
} from "../lib/auth.server";

type LoginApplication = "PLAY" | "POS" | "GO" | "KIOSK" | "QUEUE";

interface LoginContext {
  application: LoginApplication | null;
  next: string;
  returnTo: string;
  state: string | null;
  codeChallenge: string | null;
}

interface OnboardingLoaderData {
  me: AuthenticatedMeResponse;
  session: OnboardingSessionSummary;
  context: LoginContext;
  homeUrl: string;
}

interface OnboardingActionResult {
  ok: false;
  message: string;
}

const businessTypeOptions = [
  { value: "restaurant", label: "Restaurant / Food & Beverage" },
  { value: "retail", label: "Retail" },
  { value: "service", label: "Service business" },
  { value: "sport", label: "Sports / venue business" },
  { value: "general", label: "General business / Other" }
] as const;

const countryOptions = [
  { value: "TH", label: "Thailand (TH)" },
  { value: "SG", label: "Singapore (SG)" },
  { value: "MY", label: "Malaysia (MY)" },
  { value: "JP", label: "Japan (JP)" },
  { value: "ID", label: "Indonesia (ID)" },
  { value: "VN", label: "Vietnam (VN)" },
  { value: "PH", label: "Philippines (PH)" },
  { value: "AU", label: "Australia (AU)" },
  { value: "US", label: "United States (US)" },
  { value: "GB", label: "United Kingdom (GB)" }
] as const;

const currencyOptions = [
  { value: "THB", label: "THB — Thai baht" },
  { value: "SGD", label: "SGD — Singapore dollar" },
  { value: "MYR", label: "MYR — Malaysian ringgit" },
  { value: "JPY", label: "JPY — Japanese yen" },
  { value: "IDR", label: "IDR — Indonesian rupiah" },
  { value: "VND", label: "VND — Vietnamese dong" },
  { value: "PHP", label: "PHP — Philippine peso" },
  { value: "AUD", label: "AUD — Australian dollar" },
  { value: "USD", label: "USD — US dollar" },
  { value: "GBP", label: "GBP — British pound" },
  { value: "EUR", label: "EUR — Euro" }
] as const;

const timezoneOptions = [
  { value: "Asia/Bangkok", label: "Asia/Bangkok (UTC+07:00)" },
  { value: "Asia/Singapore", label: "Asia/Singapore (UTC+08:00)" },
  { value: "Asia/Kuala_Lumpur", label: "Asia/Kuala Lumpur (UTC+08:00)" },
  { value: "Asia/Jakarta", label: "Asia/Jakarta (UTC+07:00)" },
  { value: "Asia/Manila", label: "Asia/Manila (UTC+08:00)" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo (UTC+09:00)" },
  { value: "Australia/Sydney", label: "Australia/Sydney" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "America/New_York", label: "America/New York" },
  { value: "UTC", label: "UTC" }
] as const;

function safePath(value: string | null, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

function safeToken(value: string | null, minimum: number, maximum: number): string | null {
  if (!value || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function readContext(request: Request): LoginContext {
  const url = new URL(request.url);
  const applicationValue = url.searchParams.get("app")?.toUpperCase();
  const application = applicationValue === "PLAY"
    || applicationValue === "POS"
    || applicationValue === "GO"
    || applicationValue === "KIOSK"
    || applicationValue === "QUEUE"
    ? applicationValue
    : null;
  return {
    application,
    next: safePath(url.searchParams.get("next"), "/modern"),
    returnTo: safePath(url.searchParams.get("returnTo"), "/auth/callback"),
    state: safeToken(url.searchParams.get("state"), 16, 256),
    codeChallenge: safeToken(url.searchParams.get("code_challenge"), 32, 256)
  };
}

function homeUrl(request: Request): string {
  const configured = process.env.AEVO_HUB_HOME_URL?.trim();
  if (!configured) return "/modern/login";
  try {
    const url = new URL(configured, request.url);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    // Fall through to the safe in-app entry point.
  }
  return "/modern/login";
}

function loginPath(context: LoginContext): string {
  const query = new URLSearchParams({ next: context.next });
  if (context.application) query.set("app", context.application);
  if (context.application) query.set("returnTo", context.returnTo);
  if (context.state) query.set("state", context.state);
  if (context.codeChallenge) query.set("code_challenge", context.codeChallenge);
  // Route-module redirects are resolved against the /modern basename by
  // React Router. Keep this path basename-relative to avoid /modern/modern.
  return `/login?${query.toString()}`;
}

function textValue(form: FormData, name: string, maximum: number, required = false): string {
  const value = String(form.get(name) ?? "").trim();
  if (required && !value) throw new Error(`${name} is required`);
  if (value.length > maximum) throw new Error(`${name} is too long`);
  return value;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<OnboardingLoaderData> {
  const context = readContext(request);
  const { me, api } = await requireAuthenticated(request, `/modern/onboarding?${new URLSearchParams({ next: context.next }).toString()}`);
  if (me.principal) throw redirect(loginPath(context));
  const result = await api.request<{ success: true; session: OnboardingSessionSummary }>("/api/v1/hub/onboarding/session");
  return { me, session: result.session, context, homeUrl: homeUrl(request) };
}

export async function action({ request }: ActionFunctionArgs): Promise<Response | OnboardingActionResult> {
  const context = readContext(request);
  const { api } = await requireAuthenticated(request, `/modern/onboarding?${new URLSearchParams({ next: context.next }).toString()}`);
  const form = await request.formData();

  try {
    const name = textValue(form, "name", 200, true);
    const legalName = textValue(form, "legalName", 200);
    const businessType = textValue(form, "businessType", 100);
    const country = textValue(form, "country", 10).toUpperCase();
    const timezone = textValue(form, "timezone", 50);
    const currency = textValue(form, "currency", 10).toUpperCase();
    const contactEmail = textValue(form, "contactEmail", 320);
    await api.requestJson<{ success: true; organizationId: string }, Record<string, string>>("/api/v1/hub/onboarding/organization", {
      method: "POST",
      headers: requestCsrfHeaders(request),
      body: {
        sessionId: String(form.get("sessionId") ?? ""),
        name,
        ...(legalName ? { legalName } : {}),
        ...(businessType ? { businessType } : {}),
        ...(country ? { country } : {}),
        ...(timezone ? { timezone } : {}),
        ...(currency ? { currency } : {}),
        ...(contactEmail ? { contactEmail } : {})
      }
    });
    return redirect(loginPath(context));
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : "ไม่สามารถสร้าง workspace ได้" };
  }
}

export default function OnboardingRoute() {
  const data = useLoaderData() as OnboardingLoaderData;
  const actionData = useActionData() as OnboardingActionResult | undefined;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <main className="aevo-login-page">
      <section className="aevo-login-card aevo-onboarding-card" aria-labelledby="onboarding-title">
        <div className="aevo-onboarding-header">
          <a className="aevo-login-brand" href={data.homeUrl} aria-label="Aevo Hub home">
            <span className="aevo-hub-mark" aria-hidden="true">A</span>
            <span><strong>Aevo Hub</strong><small>Control plane</small></span>
          </a>
          <a className="aevo-onboarding-home-link" href={data.homeUrl}>กลับหน้า Home</a>
        </div>
        <div>
          <span className="aevo-eyebrow">Workspace setup</span>
          <h1 id="onboarding-title">สร้าง workspace ของคุณ</h1>
          <p className="aevo-login-copy">บัญชีพร้อมใช้งานแล้ว เหลือเพียงสร้าง workspace แรกเพื่อเปิด Aevo Hub และแอปที่ได้รับมอบหมาย</p>
        </div>
        <div className="aevo-onboarding-progress" aria-label={`ขั้นตอน ${data.session.currentStep}`}>
          <span className="aevo-password-meter is-strong">1 / 1</span>
          <span>Organization setup</span>
        </div>
        <Form method="post" className="aevo-login-form" aria-busy={busy}>
          <input type="hidden" name="sessionId" value={data.session.id} />
          <label>
            ชื่อ workspace
            <input type="text" name="name" defaultValue={data.me.user.displayName ?? ""} autoComplete="organization" maxLength={200} required aria-describedby="workspace-name-hint" />
            <span className="aevo-form-hint" id="workspace-name-hint">ใช้ชื่อที่ทีมของคุณจะเห็นใน Aevo Hub</span>
          </label>
          <label>
            ชื่อนิติบุคคล <span className="aevo-form-hint">(ถ้ามี)</span>
            <input type="text" name="legalName" maxLength={200} />
          </label>
          <label>
            ประเภทธุรกิจ
            <select name="businessType" defaultValue="general" required>
              {businessTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <div className="aevo-form-grid aevo-onboarding-grid">
            <label>
              ประเทศ
              <select name="country" defaultValue="TH" required>
                {countryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              สกุลเงิน
              <select name="currency" defaultValue="THB" required>
                {currencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              Timezone
              <select name="timezone" defaultValue="Asia/Bangkok" required>
                {timezoneOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <label>
            อีเมลติดต่อ <span className="aevo-form-hint">(ถ้ามี)</span>
            <input type="email" name="contactEmail" defaultValue={data.me.user.email} autoComplete="email" maxLength={320} />
          </label>
          {actionData?.ok === false ? <p className="aevo-login-alert" role="alert">{actionData.message}</p> : null}
          <button className="aevo-button aevo-button--primary aevo-login-submit" type="submit" disabled={busy}>
            {busy ? "กำลังสร้าง workspace…" : "สร้าง workspace และเปิด Aevo Hub"}
          </button>
        </Form>
        <p className="aevo-login-foot">Aevo จะสร้าง membership และ Hub assignment ให้บัญชีนี้บน server ก่อนเปิด workspace</p>
        <div className="aevo-onboarding-footer">
          <span className="aevo-form-hint">ตั้งค่าเหล่านี้ได้ภายหลังจาก Organization settings</span>
          <a className="aevo-login-link" href="/modern/login">กลับไปหน้าเข้าสู่ระบบ</a>
        </div>
      </section>
    </main>
  );
}
