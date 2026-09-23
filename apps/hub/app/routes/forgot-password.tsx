import { useState } from "react";
import type { FormEvent } from "react";

interface ApiErrorBody {
  error?: { message?: string };
}

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as ApiErrorBody | null;
  return payload?.error?.message || `Request failed with status ${response.status}`;
}

export default function ForgotPasswordRoute() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setSent(false);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/password/reset-request", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() })
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setSent(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ไม่สามารถขอลิงก์รีเซ็ตรหัสผ่านได้");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="aevo-login-page">
      <section className="aevo-login-card" aria-labelledby="forgot-password-title">
        <a className="aevo-login-brand" href="/modern" aria-label="Aevo Hub home">
          <span className="aevo-hub-mark" aria-hidden="true">A</span>
          <span><strong>Aevo Hub</strong><small>Control plane</small></span>
        </a>
        <div>
          <span className="aevo-eyebrow">Account recovery</span>
          <h1 id="forgot-password-title">ลืมรหัสผ่าน?</h1>
          <p className="aevo-login-copy">กรอกอีเมลที่ใช้สมัคร แล้วเราจะส่งลิงก์รีเซ็ตที่ปลอดภัยให้คุณ</p>
        </div>
        <form className="aevo-login-form" onSubmit={(event) => void submit(event)}>
          <label>
            อีเมล
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          {sent ? <p className="aevo-login-success" role="status">ถ้ามีบัญชีสำหรับอีเมลนี้ ระบบจะส่งลิงก์ให้ภายในไม่กี่นาที ตรวจสอบโฟลเดอร์ spam ด้วย</p> : null}
          {message ? <p className="aevo-login-alert" role="alert">{message}</p> : null}
          <button className="aevo-button aevo-button--primary aevo-login-submit" type="submit" disabled={busy}>
            {busy ? "กำลังส่ง…" : "ส่งลิงก์รีเซ็ต"}
          </button>
        </form>
        <a className="aevo-login-link" href="/modern/login">กลับไปเข้าสู่ระบบ</a>
      </section>
    </main>
  );
}
