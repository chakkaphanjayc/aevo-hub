import { useEffect, useState, type FormEvent } from "react";
import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

interface LoginLoaderData {
  next: string;
}

interface ApiErrorEnvelope {
  error?: { message?: string };
}

function safePath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

export function loader({ request }: LoaderFunctionArgs): LoginLoaderData {
  const url = new URL(request.url);
  return { next: safePath(url.searchParams.get("next")) };
}

async function errorMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as ApiErrorEnvelope | null;
  return payload?.error?.message || `Request failed with status ${response.status}`;
}

export default function AdminLoginRoute() {
  const data = useLoaderData() as LoginLoaderData;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const completeLogin = async (): Promise<void> => {
    const response = await fetch("/api/v1/access?application=ADMIN", {
      credentials: "include",
      headers: { accept: "application/json" }
    });
    const access = await response.json().catch(() => null) as { allowed?: boolean } | null;
    if (!response.ok || !access?.allowed) {
      throw new Error("บัญชีนี้ไม่มี platform role สำหรับ Aevo Admin");
    }
    window.location.assign(data.next);
  };

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/me", { credentials: "include", headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        await completeLogin();
      })
      .catch((error: unknown) => {
        if (!cancelled && error instanceof Error && error.message !== "บัญชีนี้ไม่มี platform role สำหรับ Aevo Admin") {
          setMessage(error.message);
        }
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
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password })
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      await completeLogin();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "เข้าสู่ระบบไม่สำเร็จ");
      setBusy(false);
    }
  };

  return (
    <main className="admin-login-page">
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <a className="admin-brand" href="/" aria-label="Aevo Admin home">
          <span className="admin-brand__mark" aria-hidden="true">A</span>
          <span><strong>Aevo Admin</strong><small>Platform control plane</small></span>
        </a>
        <div>
          <span className="aevo-eyebrow">Privileged application</span>
          <h1 id="admin-login-title">เข้าสู่ Aevo Admin</h1>
          <p className="admin-login-copy">ใช้สำหรับ platform operator ที่ดูแลแอปและองค์กรใน Aevo Ecosystem</p>
        </div>
        <form className="admin-login-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
          <label>
            อีเมล
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          <label>
            รหัสผ่าน
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          {message ? <p className="admin-login-alert" role="alert">{message}</p> : null}
          <button className="aevo-button aevo-button--primary admin-login-submit" type="submit" disabled={busy}>
            {busy ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}
          </button>
        </form>
        <p className="admin-login-foot">Admin session แยกจาก Hub และ Go; browser จะได้รับเฉพาะ opaque HttpOnly session cookie</p>
      </section>
    </main>
  );
}
