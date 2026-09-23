import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  deserializeRequestOptions,
  serializePublicKeyCredential,
  supportsPasskeys
} from "../lib/passkey";

type LoginApplication = "PLAY" | "POS" | "GO" | "KIOSK" | "QUEUE";
type OAuthProvider = "google" | "apple" | "line";

interface LoginLoaderData {
  application: LoginApplication | null;
  next: string;
  returnTo: string;
  state: string | null;
  codeChallenge: string | null;
  oauthError: string | null;
  csrfCookieName: string;
  appUrls: {
    play: string | null;
    pos: string | null;
    go: string | null;
    kiosk: string | null;
    queue: string | null;
  };
}

interface ApiErrorBody {
  error?: {
    message?: string;
  };
}

interface HandoffResponse {
  code: string;
}

interface MeResponse {
  user: {
    id: string;
    email: string;
    displayName?: string;
  };
  principal: unknown | null;
}

interface PasskeyOptionsResponse {
  challengeId: string;
  options: Record<string, unknown>;
}

function safePath(value: string | null, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

export function loader({ request }: LoaderFunctionArgs): LoginLoaderData {
  const url = new URL(request.url);
  const applicationValue = url.searchParams.get("app")?.toUpperCase();
  const application = applicationValue === "PLAY" || applicationValue === "POS" || applicationValue === "GO" || applicationValue === "KIOSK" || applicationValue === "QUEUE"
    ? applicationValue
    : null;
  return {
    application,
    next: safePath(url.searchParams.get("next"), "/modern"),
    returnTo: safePath(url.searchParams.get("returnTo"), "/auth/callback"),
    state: url.searchParams.get("state"),
    codeChallenge: url.searchParams.get("code_challenge"),
    oauthError: url.searchParams.get("oauth_error") ?? url.searchParams.get("auth_error"),
    csrfCookieName: process.env.CSRF_COOKIE_NAME?.trim() || "aevo_csrf",
    appUrls: {
      play: safeOrigin(process.env.AEVO_PLAY_URL),
      pos: safeOrigin(process.env.AEVO_POS_URL),
      go: safeOrigin(process.env.AEVO_GO_URL),
      kiosk: safeOrigin(process.env.AEVO_KIOSK_URL),
      queue: safeOrigin(process.env.AEVO_QUEUE_URL)
    }
  };
}

async function errorMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as ApiErrorBody | null;
  return payload?.error?.message || `Request failed with status ${response.status}`;
}

function oauthErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === "provider_denied") return "ยกเลิกการเข้าสู่ระบบจากผู้ให้บริการแล้ว";
  if (code === "invalid_state") return "คำขอเข้าสู่ระบบหมดอายุหรือไม่ถูกต้อง กรุณาลองใหม่";
  if (code === "account_unavailable") return "บัญชีนี้ยังไม่พร้อมใช้งานใน Aevo Hub";
  if (code === "password_recovery_invalid") return "ลิงก์กู้คืนรหัสผ่านหมดอายุหรือไม่ถูกต้อง กรุณาขอลิงก์ใหม่";
  if (code === "password_updated") return "เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบอีกครั้ง";
  return "ไม่สามารถเข้าสู่ระบบผ่านผู้ให้บริการนี้ได้ กรุณาลองใหม่";
}

function readCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

function onboardingPath(data: LoginLoaderData): string {
  const query = new URLSearchParams({ next: data.next });
  if (data.application) query.set("app", data.application);
  if (data.application) query.set("returnTo", data.returnTo);
  if (data.state) query.set("state", data.state);
  if (data.codeChallenge) query.set("code_challenge", data.codeChallenge);
  return `/modern/onboarding?${query.toString()}`;
}

function passwordStrength(password: string): { label: string; className: string } {
  const groups = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z\d\s]/u].filter((pattern) => pattern.test(password)).length;
  if (password.length >= 12 && groups >= 3) return { label: "แข็งแรง", className: "is-strong" };
  if (password.length >= 8 && groups >= 2) return { label: "พอใช้", className: "is-medium" };
  return { label: "อ่อน", className: "is-weak" };
}

export default function LoginRoute() {
  const data = useLoaderData() as LoginLoaderData;
  const [mode, setMode] = useState<"login" | "register">("login");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(true);
  const [passkeysSupported, setPasskeysSupported] = useState(false);
  const [message, setMessage] = useState<string | null>(() => oauthErrorMessage(data.oauthError));

  const completeDestination = async (knownMe?: MeResponse): Promise<void> => {
    const me: MeResponse = knownMe ?? await fetch("/api/auth/me", {
      credentials: "include",
      headers: { accept: "application/json", "x-aevo-app": "HUB" }
    }).then(async (response): Promise<MeResponse> => {
      if (!response.ok) throw new Error(await errorMessage(response));
      return await response.json() as MeResponse;
    });

    if (!me.principal) {
      window.location.assign(onboardingPath(data));
      return;
    }

    if (!data.application) {
      window.location.assign(data.next);
      return;
    }

    const targetOrigin = data.application === "PLAY"
      ? data.appUrls.play
      : data.application === "POS"
        ? data.appUrls.pos
        : data.application === "GO"
          ? data.appUrls.go
          : data.application === "KIOSK"
            ? data.appUrls.kiosk
            : data.appUrls.queue;
    if (!targetOrigin) throw new Error(`Aevo ${data.application} is not configured for this environment`);

    const response = await fetch("/api/auth/handoff", {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-aevo-app": "HUB",
        ...(readCookie(data.csrfCookieName) ? { "x-csrf-token": readCookie(data.csrfCookieName)! } : {})
      },
      body: JSON.stringify({
        application: data.application,
        returnTo: data.returnTo,
        ...(data.state && data.state.length >= 16 ? { state: data.state } : {}),
        ...(data.codeChallenge && data.codeChallenge.length >= 32 ? { codeChallenge: data.codeChallenge } : {})
      })
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const handoff = await response.json() as HandoffResponse;
    const callback = new URL(targetOrigin);
    callback.pathname = `${callback.pathname.replace(/\/+$/u, "")}/auth/callback`;
    callback.searchParams.set("code", handoff.code);
    if (data.state) callback.searchParams.set("state", data.state);
    callback.searchParams.set("returnTo", data.returnTo);
    window.location.assign(callback.toString());
  };

  const signInWithPasskey = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const optionsResponse = await fetch("/api/auth/passkey/authentication/options", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: "{}"
      });
      if (!optionsResponse.ok) throw new Error(await errorMessage(optionsResponse));
      const optionsPayload = await optionsResponse.json() as PasskeyOptionsResponse;
      const credential = await navigator.credentials.get({
        publicKey: deserializeRequestOptions(optionsPayload.options)
      });
      if (!credential) throw new Error("ไม่ได้รับการยืนยันจาก passkey");
      const verifyResponse = await fetch("/api/auth/passkey/authentication/verify", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: optionsPayload.challengeId,
          credential: serializePublicKeyCredential(credential)
        })
      });
      if (!verifyResponse.ok) throw new Error(await errorMessage(verifyResponse));
      await completeDestination();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ไม่สามารถเข้าสู่ระบบด้วย passkey ได้");
      setBusy(false);
    }
  };

  const beginOAuth = (provider: OAuthProvider): void => {
    setBusy(true);
    setMessage(null);
    const query = new URLSearchParams({ next: data.next });
    if (data.application) query.set("app", data.application);
    if (data.application) query.set("returnTo", data.returnTo);
    if (data.state) query.set("state", data.state);
    if (data.codeChallenge) query.set("code_challenge", data.codeChallenge);
    window.location.assign(`/api/auth/oauth/${provider}/start?${query.toString()}`);
  };

  useEffect(() => {
    setPasskeysSupported(supportsPasskeys());
    let cancelled = false;
    void fetch("/api/auth/me", { credentials: "include", headers: { accept: "application/json", "x-aevo-app": "HUB" } })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const me = await response.json() as MeResponse;
        await completeDestination(me);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "ไม่สามารถตรวจสอบ session ได้");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    if (mode === "register" && password !== confirmPassword) {
      setMessage("รหัสผ่านไม่ตรงกัน");
      setBusy(false);
      return;
    }
    try {
      const endpoint = mode === "register" ? "/api/v1/hub/onboarding/register" : "/api/auth/login";
      const body = mode === "register"
        ? { fullName: fullName.trim(), email: email.trim(), password }
        : { email: email.trim(), password };
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json", "x-aevo-app": "HUB" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      await completeDestination();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : mode === "register" ? "สร้างบัญชีไม่สำเร็จ" : "เข้าสู่ระบบไม่สำเร็จ");
      setBusy(false);
    }
  };

  return (
    <main className="aevo-login-page">
      <section className="aevo-login-card" aria-labelledby="login-title">
        <a className="aevo-login-brand" href="/modern" aria-label="Aevo Hub home">
          <span className="aevo-hub-mark" aria-hidden="true">A</span>
          <span><strong>Aevo Hub</strong><small>Control plane</small></span>
        </a>
        <div>
          <span className="aevo-eyebrow">Secure identity</span>
          <h1 id="login-title">{mode === "register" ? "สร้างบัญชี Aevo" : "ยินดีต้อนรับกลับ"}</h1>
          <p className="aevo-login-copy">
            {data.application ? `เข้าสู่ระบบเพื่อเปิด Aevo ${data.application}` : "เข้าสู่ระบบเพื่อจัดการ workspace ของคุณ"}
          </p>
        </div>
        <div className="aevo-login-mode" role="group" aria-label="Authentication mode">
          <button type="button" aria-pressed={mode === "login"} className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); setMessage(null); }}>เข้าสู่ระบบ</button>
          <button type="button" aria-pressed={mode === "register"} className={mode === "register" ? "is-active" : ""} onClick={() => { setMode("register"); setMessage(null); }}>สร้างบัญชี</button>
        </div>
        <div className="aevo-login-socials" aria-label="Social sign in">
          <button type="button" className="aevo-button aevo-button--secondary" onClick={() => beginOAuth("google")} disabled={busy}>Continue with Google</button>
          <button type="button" className="aevo-button aevo-button--secondary" onClick={() => beginOAuth("apple")} disabled={busy}>Continue with Apple</button>
          <button type="button" className="aevo-button aevo-button--secondary" onClick={() => beginOAuth("line")} disabled={busy}>Continue with LINE</button>
        </div>
        {passkeysSupported ? (
          <button type="button" className="aevo-button aevo-login-passkey" onClick={() => void signInWithPasskey()} disabled={busy}>
            ใช้ passkey เพื่อเข้าสู่ระบบ
          </button>
        ) : null}
        <div className="aevo-login-divider"><span>หรือใช้อีเมล</span></div>
        <form className="aevo-login-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
          {mode === "register" ? (
            <label>
              ชื่อที่แสดง
              <input type="text" value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" required />
            </label>
          ) : null}
          <label>
            อีเมล
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          <label>
            รหัสผ่าน
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 12 : undefined} required />
          </label>
          {mode === "login" ? <a className="aevo-login-link" href="/modern/forgot-password">ลืมรหัสผ่าน?</a> : null}
          {mode === "register" ? (
            <div className="aevo-password-policy" aria-live="polite">
              <span className={`aevo-password-meter ${passwordStrength(password).className}`}>ความแข็งแรง: {passwordStrength(password).label}</span>
              <small>ใช้ 12 ตัวอักษรขึ้นไป และผสมตัวพิมพ์เล็ก/ใหญ่ ตัวเลข หรือสัญลักษณ์อย่างน้อย 3 ประเภท</small>
            </div>
          ) : null}
          {mode === "register" ? (
            <label>
              ยืนยันรหัสผ่าน
              <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={12} required />
            </label>
          ) : null}
          {message ? <p className="aevo-login-alert" role="alert">{message}</p> : null}
          <button className="aevo-button aevo-button--primary aevo-login-submit" type="submit" disabled={busy}>
            {busy ? "กำลังตรวจสอบ…" : mode === "register" ? "สร้างบัญชีและเริ่มต้นใช้งาน" : "เข้าสู่ระบบ"}
          </button>
        </form>
        <p className="aevo-login-foot">การเข้าสู่ระบบทุกช่องทางจะสร้าง session แบบ app-scoped ที่ฝั่ง server และไม่ส่ง Supabase token ไปยัง browser</p>
      </section>
    </main>
  );
}
