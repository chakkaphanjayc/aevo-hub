import { useState } from "react";
import type { FormEvent } from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

interface ApiErrorBody {
  error?: { message?: string };
}

interface ResetLoaderData {
  csrfCookieName: string;
}

function readCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as ApiErrorBody | null;
  return payload?.error?.message || `Request failed with status ${response.status}`;
}

function passwordStrength(password: string): { label: string; className: string } {
  const groups = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z\d\s]/u].filter((pattern) => pattern.test(password)).length;
  if (password.length >= 12 && groups >= 3) return { label: "แข็งแรง", className: "is-strong" };
  if (password.length >= 8 && groups >= 2) return { label: "พอใช้", className: "is-medium" };
  return { label: "อ่อน", className: "is-weak" };
}

export default function ResetPasswordRoute() {
  const data = useLoaderData() as ResetLoaderData;
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setMessage(null);
    if (password !== confirmPassword) {
      setMessage("รหัสผ่านไม่ตรงกัน");
      return;
    }
    setBusy(true);
    try {
      const csrfToken = readCookie(data.csrfCookieName);
      const response = await fetch("/api/auth/password/update", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
        },
        body: JSON.stringify({ password })
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      window.location.assign("/modern/login?auth_error=password_updated");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ไม่สามารถเปลี่ยนรหัสผ่านได้");
      setBusy(false);
    }
  };

  const strength = passwordStrength(password);
  return (
    <main className="aevo-login-page">
      <section className="aevo-login-card" aria-labelledby="reset-password-title">
        <a className="aevo-login-brand" href="/modern" aria-label="Aevo Hub home">
          <span className="aevo-hub-mark" aria-hidden="true">A</span>
          <span><strong>Aevo Hub</strong><small>Control plane</small></span>
        </a>
        <div>
          <span className="aevo-eyebrow">Secure account recovery</span>
          <h1 id="reset-password-title">ตั้งรหัสผ่านใหม่</h1>
          <p className="aevo-login-copy">ใช้รหัสผ่านใหม่ที่ไม่ซ้ำกับบริการอื่น และมีอย่างน้อย 12 ตัวอักษร</p>
        </div>
        <form className="aevo-login-form" onSubmit={(event) => void submit(event)}>
          <label>
            รหัสผ่านใหม่
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} required />
          </label>
          <div className="aevo-password-policy" aria-live="polite">
            <span className={`aevo-password-meter ${strength.className}`}>ความแข็งแรง: {strength.label}</span>
            <small>ต้องมีตัวพิมพ์เล็ก/ใหญ่ ตัวเลข หรือสัญลักษณ์อย่างน้อย 3 ประเภท</small>
          </div>
          <label>
            ยืนยันรหัสผ่าน
            <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={12} required />
          </label>
          {message ? <p className="aevo-login-alert" role="alert">{message}</p> : null}
          <button className="aevo-button aevo-button--primary aevo-login-submit" type="submit" disabled={busy}>
            {busy ? "กำลังบันทึก…" : "เปลี่ยนรหัสผ่าน"}
          </button>
        </form>
        <p className="aevo-login-foot">หลังเปลี่ยนรหัสผ่าน session เดิมทั้งหมดจะถูกยกเลิกเพื่อความปลอดภัย</p>
      </section>
    </main>
  );
}

export function loader({}: LoaderFunctionArgs): ResetLoaderData {
  return { csrfCookieName: process.env.CSRF_COOKIE_NAME?.trim() || "aevo_csrf" };
}
