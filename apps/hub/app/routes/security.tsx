import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiClientError } from "@aevocado/contracts";
import { isAccessAllowed } from "@aevocado/app-access";
import { Form, redirect, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  createHubApiClient,
  requireHubAccess,
  requestCsrfHeaders
} from "../lib/auth.server";
import {
  deserializeCreationOptions,
  serializePublicKeyCredential,
  supportsPasskeys
} from "../lib/passkey";
import type { HubLoaderData } from "../lib/auth.shared";

interface PasskeySummary {
  id: string;
  friendlyName?: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface SecurityLoaderData {
  hub: HubLoaderData;
  passkeys: PasskeySummary[];
  passkeyAvailable: boolean;
  csrfCookieName: string;
}

interface SecurityActionResult {
  ok: false;
  message: string;
}

interface ApiErrorBody {
  error?: { message?: string };
}

interface PasskeyOptionsResponse {
  challengeId: string;
  options: Record<string, unknown>;
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

export async function loader({ request }: LoaderFunctionArgs): Promise<SecurityLoaderData> {
  const hub = await requireHubAccess(request);
  const csrfCookieName = process.env.CSRF_COOKIE_NAME?.trim() || "aevo_csrf";
  if (!isAccessAllowed(hub.access)) return { hub, passkeys: [], passkeyAvailable: false, csrfCookieName };
  try {
    const response = await createHubApiClient(request).request<{ passkeys: PasskeySummary[] }>("/api/auth/passkeys");
    return { hub, passkeys: response.passkeys, passkeyAvailable: true, csrfCookieName };
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 404 || error.status === 503)) {
      return { hub, passkeys: [], passkeyAvailable: false, csrfCookieName };
    }
    throw error;
  }
}

export async function action({ request }: ActionFunctionArgs): Promise<Response | SecurityActionResult> {
  const hub = await requireHubAccess(request);
  if (!isAccessAllowed(hub.access)) return { ok: false, message: "Hub access is required." };
  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "change-password") return { ok: false, message: "Unknown security action." };

  const currentPassword = String(form.get("currentPassword") ?? "");
  const password = String(form.get("password") ?? "");
  const confirmPassword = String(form.get("confirmPassword") ?? "");
  if (!currentPassword || !password) return { ok: false, message: "กรอกรหัสผ่านปัจจุบันและรหัสผ่านใหม่" };
  if (password !== confirmPassword) return { ok: false, message: "รหัสผ่านใหม่ไม่ตรงกัน" };
  if (password.length < 12) return { ok: false, message: "รหัสผ่านใหม่ต้องมีอย่างน้อย 12 ตัวอักษร" };

  try {
    await createHubApiClient(request).requestJson<{ success: true }, { password: string; currentPassword: string }>("/api/auth/password/update", {
      method: "POST",
      headers: requestCsrfHeaders(request),
      body: { password, currentPassword }
    });
    return redirect("/login?auth_error=password_updated");
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : "ไม่สามารถเปลี่ยนรหัสผ่านได้" };
  }
}

export default function SecurityRoute() {
  const data = useLoaderData() as SecurityLoaderData;
  const actionData = useActionData() as SecurityActionResult | undefined;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [passkeyMessage, setPasskeyMessage] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeysSupported, setPasskeysSupported] = useState(false);

  useEffect(() => {
    setPasskeysSupported(supportsPasskeys());
  }, []);

  const registerPasskey = async (): Promise<void> => {
    setPasskeyBusy(true);
    setPasskeyMessage(null);
    try {
      const optionsResponse = await fetch("/api/auth/passkey/registration/options", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json", ...(readCookie(data.csrfCookieName) ? { "x-csrf-token": readCookie(data.csrfCookieName)! } : {}) },
        body: "{}"
      });
      if (!optionsResponse.ok) throw new Error(await responseMessage(optionsResponse));
      const optionsPayload = await optionsResponse.json() as PasskeyOptionsResponse;
      const credential = await navigator.credentials.create({
        publicKey: deserializeCreationOptions(optionsPayload.options)
      });
      if (!credential) throw new Error("ไม่ได้รับการยืนยันจาก authenticator");
      const verifyResponse = await fetch("/api/auth/passkey/registration/verify", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json", ...(readCookie(data.csrfCookieName) ? { "x-csrf-token": readCookie(data.csrfCookieName)! } : {}) },
        body: JSON.stringify({ challengeId: optionsPayload.challengeId, credential: serializePublicKeyCredential(credential) })
      });
      if (!verifyResponse.ok) throw new Error(await responseMessage(verifyResponse));
      setPasskeyMessage("เพิ่ม passkey แล้ว อุปกรณ์นี้ใช้เข้าสู่ระบบได้ในครั้งถัดไป");
      revalidator.revalidate();
    } catch (error) {
      setPasskeyMessage(error instanceof Error ? error.message : "ไม่สามารถเพิ่ม passkey ได้");
    } finally {
      setPasskeyBusy(false);
    }
  };

  const removePasskey = async (passkey: PasskeySummary): Promise<void> => {
    if (!window.confirm(`ลบ passkey ${passkey.friendlyName || passkey.id} หรือไม่? หากไม่มีรหัสผ่านหรือ passkey อื่น คุณอาจเข้าสู่ระบบไม่ได้`)) return;
    setPasskeyBusy(true);
    setPasskeyMessage(null);
    try {
      const csrfToken = readCookie(data.csrfCookieName);
      const response = await fetch(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: { accept: "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) }
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setPasskeyMessage("ลบ passkey แล้ว");
      revalidator.revalidate();
    } catch (error) {
      setPasskeyMessage(error instanceof Error ? error.message : "ไม่สามารถลบ passkey ได้");
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (!isAccessAllowed(data.hub.access)) {
    return <main className="aevo-error-page"><p className="aevo-login-alert">ต้องมี Hub access ก่อนจึงจัดการความปลอดภัยได้</p></main>;
  }

  return (
    <>
      <section className="aevo-page-heading">
        <div>
          <span className="aevo-eyebrow">Account security</span>
          <h1>ความปลอดภัยของบัญชี</h1>
          <p>จัดการรหัสผ่านและ passkey ของบัญชีนี้โดยผ่าน gateway ฝั่ง server</p>
        </div>
      </section>
      <div className="aevo-security-grid">
        <section className="aevo-settings-section" aria-labelledby="password-title">
          <div className="aevo-section-heading">
            <div><span className="aevo-eyebrow">Password</span><h2 id="password-title">เปลี่ยนรหัสผ่าน</h2><p>ต้องยืนยันรหัสผ่านปัจจุบัน และ session ทั้งหมดจะถูกยกเลิกหลังเปลี่ยนสำเร็จ</p></div>
          </div>
          <Form method="post" className="aevo-login-form" aria-busy={navigation.state !== "idle"}>
            <input type="hidden" name="intent" value="change-password" />
            <label>รหัสผ่านปัจจุบัน<input type="password" name="currentPassword" autoComplete="current-password" required /></label>
            <label>รหัสผ่านใหม่<input type="password" name="password" autoComplete="new-password" minLength={12} required /></label>
            <label>ยืนยันรหัสผ่านใหม่<input type="password" name="confirmPassword" autoComplete="new-password" minLength={12} required /></label>
            {actionData?.ok === false ? <p className="aevo-login-alert" role="alert">{actionData.message}</p> : null}
            <button className="aevo-button aevo-button--primary" type="submit" disabled={navigation.state !== "idle"}>{navigation.state !== "idle" ? "กำลังบันทึก…" : "เปลี่ยนรหัสผ่าน"}</button>
          </Form>
        </section>

        <section className="aevo-settings-section" aria-labelledby="passkey-title">
          <div className="aevo-section-heading">
            <div><span className="aevo-eyebrow">Passkeys</span><h2 id="passkey-title">เข้าสู่ระบบด้วย passkey</h2><p>ใช้ Face ID, Touch ID หรือ security key โดยไม่ส่งรหัสผ่านไปยัง browser</p></div>
            <span className="aevo-count-badge">{data.passkeys.length} registered</span>
          </div>
          {!data.passkeyAvailable ? <p className="aevo-form-hint">Passkey ยังไม่เปิดใช้งานใน environment นี้ หรือ provider ยังไม่พร้อม</p> : null}
          {data.passkeyAvailable && passkeysSupported ? <button className="aevo-button aevo-button--secondary" type="button" onClick={() => void registerPasskey()} disabled={passkeyBusy}>{passkeyBusy ? "กำลังดำเนินการ…" : "เพิ่ม passkey จากอุปกรณ์นี้"}</button> : null}
          {data.passkeyAvailable && !passkeysSupported ? <p className="aevo-form-hint">เบราว์เซอร์นี้ไม่รองรับ WebAuthn passkey</p> : null}
          {passkeyMessage ? <p className="aevo-inline-alert" role="status">{passkeyMessage}</p> : null}
          {data.passkeys.length > 0 ? (
            <div className="aevo-passkey-list">
              {data.passkeys.map((passkey) => (
                <div className="aevo-passkey-item" key={passkey.id}>
                  <div><strong>{passkey.friendlyName || "Passkey"}</strong><small>เพิ่มเมื่อ {passkey.createdAt.slice(0, 10)}</small></div>
                  <button className="aevo-button aevo-button--ghost" type="button" onClick={() => void removePasskey(passkey)} disabled={passkeyBusy}>ลบ</button>
                </div>
              ))}
            </div>
          ) : <p className="aevo-form-hint">ยังไม่มี passkey ที่ผูกกับบัญชีนี้</p>}
        </section>
      </div>
    </>
  );
}
