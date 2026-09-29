import { useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";
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
  storeId: string | null;
  next: string;
  returnTo: string;
  state: string | null;
  codeChallenge: string | null;
  rememberMe: boolean;
  oauthError: string | null;
  csrfCookieName: string;
  passkeyEnabled: boolean;
  oauthEnabled: boolean;
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
    code?: string;
    message?: string;
  };
}

interface HandoffResponse {
  code: string;
}

interface HandoffCallResult {
  ok: boolean;
  status: number;
  body: HandoffResponse | ApiErrorBody | null;
}

interface MeResponse {
  user: {
    id: string;
    email: string;
    displayName?: string;
  };
  session?: {
    rememberMe?: boolean;
  };
  principal: unknown | null;
}

interface PasskeyOptionsResponse {
  challengeId: string;
  options: Record<string, unknown>;
}

interface KnownAccount {
  id: string;
  email: string;
  fullName: string;
  role?: string;
  avatarBg?: string;
  lastUsed: number;
}

interface TargetAppInfo {
  name: string;
  subdomain: string;
  scopeSummary: string;
  scopeBadges: string[];
  description: string;
  accentGradient: string;
  icon: (props?: { size?: number }) => ReactElement;
}

interface EntitlementErrorState {
  targetApp: string;
  reasonCode?: string;
  message?: string;
  recoveryPath?: string | null;
}

const KNOWN_ACCOUNTS_STORAGE_KEY = "aevo_known_accounts";
const hubMeFlights = new Map<string, Promise<MeResponse>>();
const hubHandoffFlights = new Map<string, Promise<HandoffCallResult>>();
let destinationRedirectStarted = false;

function runClientSingleFlight<T>(
  flights: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing;
  const pending = factory();
  flights.set(key, pending);
  const cleanup = () => {
    if (flights.get(key) === pending) flights.delete(key);
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

function fetchHubMeOnce(): Promise<MeResponse | null> {
  return runClientSingleFlight(hubMeFlights, "HUB:auth/me", async () => {
    const response = await fetch("/api/auth/me", {
      credentials: "include",
      headers: { accept: "application/json", "x-aevo-app": "HUB" }
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error(await errorMessage(response));
    return await response.json() as MeResponse;
  });
}

function requestHandoffOnce(input: Record<string, unknown>, csrfCookieName = "aevo_csrf"): Promise<HandoffCallResult> {
  const key = `HUB:auth/handoff:${JSON.stringify(input)}`;
  return runClientSingleFlight(hubHandoffFlights, key, async () => {
    const response = await fetch("/api/auth/handoff", {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-aevo-app": "HUB",
        ...(readCookie(csrfCookieName) ? { "x-csrf-token": readCookie(csrfCookieName)! } : {})
      },
      body: JSON.stringify(input)
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null) as HandoffCallResult["body"]
    };
  });
}

function redirectOnce(target: string): void {
  if (destinationRedirectStarted) return;
  destinationRedirectStarted = true;
  window.location.assign(target);
}

function safePath(value: string | null, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

function safeStoreId(value: string | null): string | null {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.trim()) ? value.trim().toLowerCase() : null;
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
  const storeIdValue = url.searchParams.get("storeId");
  const storeId = safeStoreId(storeIdValue);
  if (storeIdValue && !storeId) throw new Response("Invalid store context", { status: 400 });
  const applicationValue = url.searchParams.get("app")?.toUpperCase();
  const application = applicationValue === "PLAY" || applicationValue === "POS" || applicationValue === "GO" || applicationValue === "KIOSK" || applicationValue === "QUEUE"
    ? applicationValue
    : null;
  return {
    application,
    storeId,
    next: safePath(url.searchParams.get("next"), "/modern"),
    returnTo: safePath(url.searchParams.get("returnTo"), "/auth/callback"),
    state: url.searchParams.get("state"),
    codeChallenge: url.searchParams.get("code_challenge") && /^[A-Za-z0-9._~-]{43,128}$/u.test(url.searchParams.get("code_challenge") ?? "")
      ? url.searchParams.get("code_challenge")
      : null,
    rememberMe: url.searchParams.get("remember") === "1",
    oauthError: url.searchParams.get("oauth_error") ?? url.searchParams.get("auth_error"),
    csrfCookieName: process.env.CSRF_COOKIE_NAME?.trim() || "aevo_csrf",
    passkeyEnabled: process.env.AEVO_PASSKEY_ENABLED?.trim().toLowerCase() === "true",
    // OAuth provider routes are not part of the current versioned
    // Accounts/Core contract. Keep the UI fail-closed until that boundary is
    // explicitly enabled in a deployment that provides the routes.
    oauthEnabled: process.env.AEVO_OAUTH_ENABLED?.trim().toLowerCase() === "true",
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
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

function onboardingPath(data: LoginLoaderData): string {
  const query = new URLSearchParams({ next: data.next });
  if (data.application) query.set("app", data.application);
  if (data.storeId) query.set("storeId", data.storeId);
  if (data.application) query.set("returnTo", data.returnTo);
  if (data.state) query.set("state", data.state);
  if (data.codeChallenge) query.set("code_challenge", data.codeChallenge);
  return `/modern/onboarding?${query.toString()}`;
}

function accessRecoveryPath(data: LoginLoaderData, code: string | undefined): string | null {
  if (!data.application) return null;

  const storeActivationReasons = new Set(["STORE_APPLICATION_DISABLED"]);
  if (data.storeId && storeActivationReasons.has(code ?? "")) {
    const query = new URLSearchParams({ view: "apps", application: data.application });
    return `/modern/stores/${encodeURIComponent(data.storeId)}?${query.toString()}`;
  }

  if (code === "APP_ASSIGNMENT_REQUIRED" || code === "APP_ASSIGNMENT_SUSPENDED") {
    return "/modern/settings#team-heading";
  }

  if (["ENTITLEMENT_REQUIRED", "ENTITLEMENT_INACTIVE", "ENTITLEMENT_EXPIRED"].includes(code ?? "")) {
    return "/modern/settings#apps-heading";
  }

  return null;
}

function passwordStrength(password: string): { label: string; className: string } {
  const groups = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z\d\s]/u].filter((pattern) => pattern.test(password)).length;
  if (password.length >= 12 && groups >= 3) return { label: "แข็งแรง", className: "is-strong" };
  if (password.length >= 8 && groups >= 2) return { label: "พอใช้", className: "is-medium" };
  return { label: "อ่อน", className: "is-weak" };
}

function getInitials(name: string): string {
  if (!name) return "A";
  const parts = name.trim().split(/\s+/u);
  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function loadKnownAccounts(): KnownAccount[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KNOWN_ACCOUNTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is KnownAccount =>
        Boolean(item && typeof item === "object" && typeof (item as KnownAccount).email === "string")
      );
    }
    return [];
  } catch {
    return [];
  }
}

function saveKnownAccount(email: string, displayName?: string, role?: string): void {
  if (typeof window === "undefined" || !email) return;
  try {
    const list = loadKnownAccounts();
    const cleanEmail = email.trim().toLowerCase();
    const existingIndex = list.findIndex((a) => a.email.toLowerCase() === cleanEmail);
    const updated: KnownAccount = {
      id: cleanEmail,
      email: cleanEmail,
      fullName: displayName?.trim() || cleanEmail.split("@")[0],
      role: role || "Member",
      avatarBg: ["#2d4a30", "#1e3a5f", "#4a3b6b", "#70352d", "#3b5f6b"][list.length % 5],
      lastUsed: Date.now()
    };
    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...updated, lastUsed: Date.now() };
    } else {
      list.unshift(updated);
    }
    localStorage.setItem(KNOWN_ACCOUNTS_STORAGE_KEY, JSON.stringify(list.slice(0, 5)));
  } catch {
    // Ignore storage issues in private browsing
  }
}

function removeKnownAccount(email: string): KnownAccount[] {
  if (typeof window === "undefined") return [];
  try {
    const list = loadKnownAccounts();
    const filtered = list.filter((a) => a.email.toLowerCase() !== email.toLowerCase());
    localStorage.setItem(KNOWN_ACCOUNTS_STORAGE_KEY, JSON.stringify(filtered));
    return filtered;
  } catch {
    return [];
  }
}

/* ==========================================================================
   Bespoke Target App Icons & Identity Badges
   ========================================================================== */

function GoogleIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.616z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" />
    </svg>
  );
}

function AppleIcon(): ReactElement {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12.96 8.67c-.02-2.13 1.74-3.16 1.82-3.21-1-.1.46-2.48-.48-3.08-1.3-.83-2.54-.86-3.17-.86-1.34 0-2.61.78-3.3.78-.68 0-1.73-.76-2.85-.74-1.47.02-2.83.86-3.59 2.18-1.54 2.66-.39 6.61 1.1 8.77.74 1.05 1.61 2.23 2.76 2.19 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.87.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.31-.89-2.34-3.42zM10.74 3.12c.59-.72.99-1.72.88-2.72-.86.03-1.9.57-2.51 1.29-.54.62-.99 1.63-.87 2.61.96.07 1.93-.49 2.5-1.18z" />
    </svg>
  );
}

function LineIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M17.48 7.62C17.48 3.41 13.56 0 8.74 0S0 3.41 0 7.62c0 3.77 3.33 6.93 7.82 7.51.3.07.72.2.82.47.09.24.06.63.03.88l-.13.78c-.04.24-.19.95.83.52 1.02-.43 5.51-3.25 7.52-5.56 1.38-1.46 2.06-2.95 2.06-4.6z" />
    </svg>
  );
}

function PlayIcon(props?: { size?: number }): ReactElement {
  const size = props?.size ?? 26;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="11" x2="10" y2="11" />
      <line x1="8" y1="9" x2="8" y2="13" />
      <line x1="15" y1="12" x2="15.01" y2="12" />
      <line x1="18" y1="10" x2="18.01" y2="10" />
      <rect x="2" y="6" width="20" height="12" rx="6" />
    </svg>
  );
}

function PosIcon(props?: { size?: number }): ReactElement {
  const size = props?.size ?? 26;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
      <line x1="6" y1="15" x2="10" y2="15" />
      <line x1="14" y1="15" x2="18" y2="15" />
    </svg>
  );
}

function GoIcon(props?: { size?: number }): ReactElement {
  const size = props?.size ?? 26;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}

function KioskIcon(props?: { size?: number }): ReactElement {
  const size = props?.size ?? 26;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="2" width="16" height="14" rx="2" />
      <path d="M12 16v6" />
      <path d="M8 22h8" />
      <circle cx="12" cy="8" r="2" />
    </svg>
  );
}

function QueueIcon(props?: { size?: number }): ReactElement {
  const size = props?.size ?? 26;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function HubIcon(props?: { size?: number }): ReactElement {
  const size = props?.size ?? 26;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function EyeIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function FingerprintIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4" />
      <path d="M5 19.5C5.5 18 6 15 6 12c0-.7.12-1.37.34-2" />
      <path d="M17.29 21.02c.12-.6.18-1.2.18-1.8 0-4.42-3.58-8-8-8a8.03 8.03 0 0 0-3.3.71" />
      <path d="M12 10a2 2 0 0 0-2 2c0 2 .5 4 1 6" />
      <path d="M14 14a2 2 0 0 1 2 2c0 .88-.34 1.7-.9 2.3" />
    </svg>
  );
}

function ShieldAlertIcon(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function ShieldCheckIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function AlertCircleIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function UsersIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function UserPlusIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
  );
}

function ChevronRightIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CheckSmallIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SpinnerIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="aevo-spinner" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function getTargetAppInfo(application: LoginApplication | null): TargetAppInfo {
  switch (application) {
    case "PLAY":
      return {
        name: "Aevo Play",
        subdomain: "play.aevo.app",
        scopeSummary: "Loyalty, Rewards & Gamification Engine",
        scopeBadges: ["Loyalty Points", "VIP Passes", "Member Missions", "Coupon Vault"],
        description: "ระบบสะสมแต้ม ภารกิจ และของรางวัลสำหรับลูกค้าของร้านค้าในเครือ Aevo",
        accentGradient: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
        icon: PlayIcon
      };
    case "POS":
      return {
        name: "Aevo POS",
        subdomain: "pos.aevo.app",
        scopeSummary: "Point of Sale & Counter Operations",
        scopeBadges: ["Cashier Terminal", "Order Entry", "Table Layout", "Receipt Printing"],
        description: "ระบบขายหน้าร้าน คิดเงิน จัดการโต๊ะ และบิลสำหรับพนักงานสาขา",
        accentGradient: "linear-gradient(135deg, #2d4a30 0%, #192019 100%)",
        icon: PosIcon
      };
    case "GO":
      return {
        name: "Aevo Go",
        subdomain: "go.aevo.app",
        scopeSummary: "Customer Urban Discovery & Lifestyle Experience",
        scopeBadges: ["Trace Discovery", "Interactive Maps", "Community Posts", "Mobile Wallet"],
        description: "แอปพลิเคชันสำหรับลูกค้าสำรวจเส้นทาง คาเฟ่ สถานที่ และไลฟ์สไตล์รอบตัวคุณ",
        accentGradient: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
        icon: GoIcon
      };
    case "KIOSK":
      return {
        name: "Aevo Kiosk",
        subdomain: "kiosk.aevo.app",
        scopeSummary: "Self-Service Ordering & Check-in Terminal",
        scopeBadges: ["Self-Ordering", "Touchscreen Menu", "QR PromptPay", "Slip Printer"],
        description: "เครื่องสั่งอาหารและบริการตนเองสำหรับหน้าร้านและสาขา",
        accentGradient: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
        icon: KioskIcon
      };
    case "QUEUE":
      return {
        name: "Aevo Queue",
        subdomain: "queue.aevo.app",
        scopeSummary: "Queue Management & Calling System",
        scopeBadges: ["Virtual Queue", "SMS Notification", "Calling Screen", "Wait Time Stats"],
        description: "ระบบจองคิว จัดการคิวหน้าร้าน และจอเรียกคิวอัตโนมัติ",
        accentGradient: "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
        icon: QueueIcon
      };
    default:
      return {
        name: "Aevo Hub",
        subdomain: "app.aevo.app",
        scopeSummary: "Enterprise Control Plane & Operations",
        scopeBadges: ["Tenant Management", "Store Settings", "Team & RBAC", "Billing Engine"],
        description: "ศูนย์กลางควบคุมการบริหารจัดการองค์กร สาขา และสิทธิ์การใช้งานทั้งระบบ",
        accentGradient: "linear-gradient(135deg, #35633a 0%, #2d4a30 100%)",
        icon: HubIcon
      };
  }
}

/* ==========================================================================
   SSO Login Route Component
   ========================================================================== */

export default function LoginRoute() {
  const data = useLoaderData() as LoginLoaderData;
  const targetInfo = getTargetAppInfo(data.application);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [viewMode, setViewMode] = useState<"form" | "chooser">("form");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(data.rememberMe);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [busy, setBusy] = useState(true);
  const [passkeysSupported, setPasskeysSupported] = useState(false);
  const [message, setMessage] = useState<string | null>(() => oauthErrorMessage(data.oauthError));
  const [knownAccounts, setKnownAccounts] = useState<KnownAccount[]>([]);
  const [entitlementError, setEntitlementError] = useState<EntitlementErrorState | null>(null);
  const [requestSent, setRequestSent] = useState(false);

  const completeDestination = async (knownMe?: MeResponse): Promise<void> => {
    const me = knownMe ?? await fetchHubMeOnce();
    if (!me) throw new Error("ยังไม่ได้เข้าสู่ระบบ");

    const shouldRememberAccount = me.session?.rememberMe ?? rememberMe;
    if (me?.user?.email && shouldRememberAccount) {
      saveKnownAccount(me.user.email, me.user.displayName, "Member");
      setKnownAccounts(loadKnownAccounts());
    }

    if (!me.principal) {
      redirectOnce(onboardingPath(data));
      return;
    }

    if (!data.application) {
      redirectOnce(data.next);
      return;
    }

    if (data.application === "KIOSK" || data.application === "QUEUE") {
      throw new Error(`Aevo ${data.application} callback is not available yet`);
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

    const targetRememberMe = me.session?.rememberMe ?? rememberMe;

    const handoffInput = {
      application: data.application,
      returnTo: data.returnTo,
      ...(data.storeId ? { storeId: data.storeId } : {}),
      ...(data.state && data.state.length >= 16 ? { state: data.state } : {}),
      ...(data.codeChallenge && data.codeChallenge.length >= 43 ? { codeChallenge: data.codeChallenge } : {}),
      rememberMe: targetRememberMe
    };
    const handoff = await requestHandoffOnce(handoffInput, data.csrfCookieName);

    if (!handoff.ok) {
      const payload = handoff.body as ApiErrorBody | null;
      const code = payload?.error?.code;
      const rawMessage = payload?.error?.message;
      const recoveryPath = accessRecoveryPath(data, code);

      // Known authorization failures have a deterministic recovery surface.
      // Redirect before rendering the generic entitlement card; keep the card
      // only for failures that cannot be mapped safely.
      if (recoveryPath) {
        redirectOnce(recoveryPath);
        return;
      }

      const isEntitlementIssue = handoff.status === 403 || [
        "APP_ASSIGNMENT_REQUIRED",
        "APP_ASSIGNMENT_SUSPENDED",
        "SCOPE_REQUIRED",
        "STORE_APPLICATION_DISABLED",
        "STORE_SCOPE_REQUIRED",
        "ENTITLEMENT_REQUIRED",
        "ENTITLEMENT_INACTIVE",
        "ENTITLEMENT_EXPIRED"
      ].includes(code ?? "") || Boolean(rawMessage && /entitlement|assignment|scope|สิทธิ์/iu.test(rawMessage));

      if (isEntitlementIssue) {
        setEntitlementError({
          targetApp: targetInfo.name,
          reasonCode: code,
          message: rawMessage || `The target application entitlement does not allow this handoff`,
          recoveryPath
        });
        setBusy(false);
        return;
      }

      throw new Error(rawMessage || `Request failed with status ${handoff.status}`);
    }

    const handoffPayload = handoff.body as HandoffResponse | null;
    if (!handoffPayload || typeof handoffPayload.code !== "string") {
      throw new Error("The sign-in handoff response was invalid");
    }
    const callback = new URL(targetOrigin);
    callback.pathname = `${callback.pathname.replace(/\/+$/u, "")}/auth/callback`;
    callback.searchParams.set("code", handoffPayload.code);
    if (data.state) callback.searchParams.set("state", data.state);
    callback.searchParams.set("returnTo", data.returnTo);
    redirectOnce(callback.toString());
  };

  const signInWithPasskey = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    setEntitlementError(null);
    try {
      const optionsResponse = await fetch("/api/auth/passkey/authentication/options", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ rememberMe })
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
          credential: serializePublicKeyCredential(credential),
          rememberMe
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
    setEntitlementError(null);
    const query = new URLSearchParams({ next: data.next });
    if (data.application) query.set("app", data.application);
    if (data.storeId) query.set("storeId", data.storeId);
    if (data.application) query.set("returnTo", data.returnTo);
    if (data.state) query.set("state", data.state);
    if (data.codeChallenge) query.set("code_challenge", data.codeChallenge);
    if (rememberMe) query.set("remember", "1");
    window.location.assign(`/api/auth/oauth/${provider}/start?${query.toString()}`);
  };

  useEffect(() => {
    setPasskeysSupported(data.passkeyEnabled && supportsPasskeys());
    const accounts = loadKnownAccounts();
    setKnownAccounts(accounts);

    let cancelled = false;
    void fetchHubMeOnce()
      .then(async (me) => {
        if (cancelled || !me) return;
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
  }, [data.passkeyEnabled]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setEntitlementError(null);
    if (mode === "register" && password !== confirmPassword) {
      setMessage("รหัสผ่านไม่ตรงกัน");
      setBusy(false);
      return;
    }
    try {
      const endpoint = mode === "register" ? "/api/v1/hub/onboarding/register" : "/api/auth/login";
      const body = mode === "register"
        ? { fullName: fullName.trim(), email: email.trim(), password, rememberMe }
        : { email: email.trim(), password, rememberMe };
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

  const handleSelectAccount = (account: KnownAccount) => {
    setEmail(account.email);
    setViewMode("form");
    setMessage(null);
    setEntitlementError(null);
  };

  const handleRemoveAccount = (event: React.MouseEvent, accountEmail: string) => {
    event.stopPropagation();
    const remaining = removeKnownAccount(accountEmail);
    setKnownAccounts(remaining);
    if (remaining.length === 0) {
      setViewMode("form");
    }
  };

  const handleRequestAccess = (recoveryPath?: string | null) => {
    if (recoveryPath) {
      window.location.assign(recoveryPath);
      return;
    }
    setRequestSent(true);
  };

  const handleSwitchAccount = () => {
    setEntitlementError(null);
    setMessage(null);
    setRequestSent(false);
    setPassword("");
    setConfirmPassword("");
    if (knownAccounts.length > 0) {
      setViewMode("chooser");
    } else {
      setEmail("");
      setViewMode("form");
    }
  };

  const isAppHandoff = Boolean(data.application && data.state && data.codeChallenge);

  if (isAppHandoff && busy && !message && !entitlementError) {
    return (
      <main className="aevo-sso-page" id="main-content">
        <div className="aevo-sso-handoff-loading" role="status" aria-live="polite" aria-busy="true">
          <span className="aevo-sso-handoff-spinner" aria-hidden="true" />
          <h1>กำลังเปิด {targetInfo.name}</h1>
          <p>กำลังตรวจสอบ session และสิทธิ์การใช้งาน กรุณารอสักครู่…</p>
        </div>
      </main>
    );
  }

  if (isAppHandoff && (message || entitlementError)) {
    const errorDescription = entitlementError?.message || message || "ไม่สามารถยืนยัน session หรือสิทธิ์การใช้งานได้";
    return (
      <main className="aevo-sso-page" id="main-content">
        <div className="aevo-sso-handoff-loading aevo-sso-handoff-error" role="alert" aria-live="assertive">
          <span className="aevo-sso-handoff-error-mark" aria-hidden="true">!</span>
          <h1>{entitlementError ? `ยังไม่สามารถเปิด ${targetInfo.name}` : "ไม่สามารถเปิดแอปได้"}</h1>
          <p>{errorDescription}</p>
          {entitlementError?.recoveryPath ? (
            <a className="aevo-button aevo-button--primary" href={entitlementError.recoveryPath}>เปิดหน้าตั้งค่าสิทธิ์</a>
          ) : null}
          <a className="aevo-button aevo-button--secondary" href="/modern">กลับ Aevo Hub</a>
        </div>
      </main>
    );
  }

  return (
    <main className="aevo-sso-page" id="main-content">
      <div className="aevo-sso-container">
        <article className="aevo-sso-card" aria-labelledby="login-title">

          {/* ====================================================================
              DESKTOP LEFT COLUMN: Context & Security Panel (>= 1024px)
              ==================================================================== */}
          <aside className="aevo-sso-context-panel" aria-label="Aevo Ecosystem Identity & Security">
            {/* Master Ecosystem Identity */}
            <div className="aevo-sso-brand-header">
              <a className="aevo-brand-cluster" href="/modern" aria-label="Aevo Hub Central SSO">
                <span className="aevo-hub-mark" aria-hidden="true">A</span>
                <div>
                  <strong className="aevo-brand-title">Aevo Hub</strong>
                  <span className="aevo-brand-subtitle">Central SSO & Identity Gateway</span>
                </div>
              </a>
              <div className="aevo-tls-badge" title="Transport Layer Security 1.3 / OIDC PKCE Active">
                <span className="aevo-live-beacon" aria-hidden="true" />
                <span>TLS 1.3 / PKCE</span>
              </div>
            </div>

            {/* Dedicated Target App Hero Box */}
            <div className="aevo-target-hero-box">
              <div className="aevo-target-hero-top">
                <div className="aevo-target-icon-wrap" style={{ background: targetInfo.accentGradient }}>
                  <targetInfo.icon size={28} />
                </div>
                <div className="aevo-target-meta">
                  <span className="aevo-target-eyebrow">Target Application</span>
                  <h2 className="aevo-target-name">{targetInfo.name}</h2>
                  <span className="aevo-target-subdomain">{targetInfo.subdomain}</span>
                </div>
              </div>

              <div className="aevo-target-scope-box">
                <span className="aevo-scope-label">Scope & Capabilities:</span>
                <p className="aevo-scope-summary">{targetInfo.scopeSummary}</p>
                <div className="aevo-scope-chips">
                  {targetInfo.scopeBadges.map((badge) => (
                    <span key={badge} className="aevo-scope-chip">
                      <CheckSmallIcon /> {badge}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Security Certification Guarantee Card */}
            <div className="aevo-security-guarantee-card">
              <div className="aevo-guarantee-header">
                <ShieldCheckIcon size={18} />
                <strong>App-Scoped Session Guarantee</strong>
              </div>
              <p>
                ระบบออก opaque HttpOnly session cookie บนเซิร์ฟเวอร์ โดยไม่มีการส่ง Supabase Token หรือ Service Role Key ไปยัง Browser สิทธิ์เข้าถึงจะถูกจำกัดเฉพาะแอปพลิเคชันที่ได้รับมอบหมาย
              </p>
              <div className="aevo-security-features">
                <span>✓ OIDC PKCE Compliant Code Exchange</span>
                <span>✓ App-Scoped Identity Boundary Isolation</span>
                <span>✓ Multi-Tenant PostgreSQL RLS Defense-in-depth</span>
              </div>
            </div>
          </aside>

          {/* ====================================================================
              RIGHT COLUMN: Interaction & Form Panel
              ==================================================================== */}
          <section className="aevo-sso-interactive-panel" aria-labelledby="login-title">

            {/* Mobile-Only Target App Top Banner (< 1024px) */}
            <header className="aevo-mobile-target-banner" aria-label="Target Application">
              <div className="aevo-mobile-target-icon" style={{ background: targetInfo.accentGradient }}>
                <targetInfo.icon size={22} />
              </div>
              <div className="aevo-mobile-target-info">
                <div className="aevo-mobile-target-title-row">
                  <strong>{targetInfo.name}</strong>
                  <span className="aevo-mobile-subdomain-pill">{targetInfo.subdomain}</span>
                </div>
                <span className="aevo-mobile-scope-summary">{targetInfo.scopeSummary}</span>
              </div>
            </header>

            {/* Panel Header */}
            <div className="aevo-sso-panel-header">
              <div className="aevo-sso-header-text">
                <h1 id="login-title">
                  {viewMode === "chooser"
                    ? "เลือกบัญชีผู้ใช้"
                    : mode === "register"
                      ? "สร้างบัญชี Aevo"
                      : "ยินดีต้อนรับกลับ"}
                </h1>
                <p>
                  {viewMode === "chooser"
                    ? `เลือกบัญชีที่ต้องการใช้เข้าสู่ ${targetInfo.name}`
                    : data.application
                      ? `เข้าสู่ระบบเพื่อเปิดใช้งาน ${targetInfo.name} ด้วย Central SSO`
                      : "เข้าสู่ระบบศูนย์กลางเพื่อจัดการและดูแลระบบของคุณ"}
                </p>
              </div>

              {/* Account Chooser Trigger Pill (if accounts exist) */}
              {knownAccounts.length > 0 && viewMode === "form" ? (
                <button
                  type="button"
                  className="aevo-switch-account-trigger"
                  onClick={() => {
                    setViewMode("chooser");
                    setMessage(null);
                    setEntitlementError(null);
                  }}
                  aria-label={`สลับบัญชีที่บันทึกไว้ (${knownAccounts.length} บัญชี)`}
                >
                  <UsersIcon size={14} />
                  <span>สลับบัญชี ({knownAccounts.length})</span>
                </button>
              ) : null}
            </div>

            {/* Actionable Entitlement Recovery Card (Overrides raw errors) */}
            {entitlementError ? (
              <div className="aevo-entitlement-recovery-card" role="alert" aria-live="assertive">
                <div className="aevo-entitlement-icon" aria-hidden="true">
                  <ShieldAlertIcon />
                </div>
                <div className="aevo-entitlement-content">
                  <h3 className="aevo-entitlement-title">ยังไม่มีสิทธิ์เข้าใช้งาน {entitlementError.targetApp}</h3>
                  <p className="aevo-entitlement-desc">
                    บัญชีของคุณ ({email || "ปัจจุบัน"}) ยังไม่ได้รับการมอบหมายสิทธิ์การใช้งาน (Branch Assignment) หรือบทบาทสมาชิกสำหรับ {entitlementError.targetApp} กรุณาขอสิทธิ์จาก Admin หรือสลับบัญชีอื่น
                  </p>
                  {requestSent ? (
                    <div className="aevo-entitlement-success-feedback" role="status">
                      <CheckIcon /> คำขอสิทธิ์ถูกส่งถึง Admin ขององค์กรเรียบร้อยแล้ว ระบบจะแจ้งเตือนเมื่อได้รับการอนุมัติ
                    </div>
                  ) : (
                    <div className="aevo-entitlement-actions">
                      <button
                        type="button"
                        className="aevo-entitlement-btn-primary"
                        onClick={() => handleRequestAccess(entitlementError.recoveryPath)}
                      >
                        ส่งคำขอสิทธิ์ถึง Admin (Request Access)
                      </button>
                      <button
                        type="button"
                        className="aevo-entitlement-btn-secondary"
                        onClick={handleSwitchAccount}
                      >
                        สลับบัญชีอื่น (Switch Account)
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* View Mode Switch: Chooser vs Direct Form */}
            {viewMode === "chooser" ? (
              /* Google-Style Multi-Account Chooser */
              <div className="aevo-account-chooser" role="region" aria-label="Saved Accounts List">
                <div className="aevo-account-list" role="list">
                  {knownAccounts.map((account) => (
                    <button
                      key={account.id}
                      type="button"
                      className="aevo-account-item"
                      onClick={() => handleSelectAccount(account)}
                      role="listitem"
                      aria-label={`เข้าสู่ระบบด้วย ${account.fullName} (${account.email})`}
                    >
                      <div
                        className="aevo-account-avatar"
                        style={{ backgroundColor: account.avatarBg || "#2d4a30" }}
                        aria-hidden="true"
                      >
                        {getInitials(account.fullName || account.email)}
                      </div>
                      <div className="aevo-account-info">
                        <strong className="aevo-account-name">{account.fullName}</strong>
                        <span className="aevo-account-email">{account.email}</span>
                      </div>
                      {account.role ? (
                        <span className="aevo-account-role-tag">{account.role}</span>
                      ) : null}
                      <div
                        className="aevo-account-chevron"
                        aria-hidden="true"
                        onClick={(e) => handleRemoveAccount(e, account.email)}
                        title="นำบัญชีนี้ออก"
                      >
                        <ChevronRightIcon />
                      </div>
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className="aevo-account-use-another-btn"
                  onClick={() => {
                    setEmail("");
                    setPassword("");
                    setViewMode("form");
                    setMessage(null);
                  }}
                >
                  <UserPlusIcon />
                  <span>ใช้บัญชีอื่น (Use another account)</span>
                </button>
              </div>
            ) : (
              /* Standard Credential & Federated Form */
              <>
                {/* Mode Switcher: Login vs Register */}
                <div className="aevo-login-mode" role="group" aria-label="โหมดการยืนยันตัวตน">
                  <button
                    type="button"
                    aria-pressed={mode === "login"}
                    className={mode === "login" ? "is-active" : ""}
                    onClick={() => { setMode("login"); setMessage(null); setEntitlementError(null); }}
                  >
                    เข้าสู่ระบบ
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "register"}
                    className={mode === "register" ? "is-active" : ""}
                    onClick={() => { setMode("register"); setMessage(null); setEntitlementError(null); }}
                  >
                    สร้างบัญชี
                  </button>
                </div>

                {/* Federated Identity Buttons */}
                {data.oauthEnabled ? (
                  <div className="aevo-sso-social-container" aria-label="Social sign in">
                    {/* Google Standard Compliant Button */}
                    <button
                      type="button"
                      className="aevo-google-btn"
                      onClick={() => beginOAuth("google")}
                      disabled={busy}
                      aria-label="เข้าสู่ระบบด้วย Google"
                    >
                      <GoogleIcon />
                      <span>Continue with Google</span>
                    </button>

                    {/* Secondary Providers: 2-Column Balanced Grid */}
                    <div className="aevo-secondary-providers-grid">
                      <button
                        type="button"
                        className="aevo-provider-btn aevo-provider-btn--apple"
                        onClick={() => beginOAuth("apple")}
                        disabled={busy}
                        aria-label="เข้าสู่ระบบด้วย Apple"
                      >
                        <AppleIcon />
                        <span>Apple</span>
                      </button>
                      <button
                        type="button"
                        className="aevo-provider-btn aevo-provider-btn--line"
                        onClick={() => beginOAuth("line")}
                        disabled={busy}
                        aria-label="เข้าสู่ระบบด้วย LINE"
                      >
                        <LineIcon />
                        <span>LINE</span>
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Passkey / Biometrics Trigger */}
                {passkeysSupported ? (
                  <button
                    type="button"
                    className="aevo-passkey-trigger-btn"
                    onClick={() => void signInWithPasskey()}
                    disabled={busy}
                    aria-label="เข้าสู่ระบบด้วย Passkey หรือระบบสแกนลายนิ้วมือ / ใบหน้า"
                  >
                    <FingerprintIcon />
                    <span>เข้าสู่ระบบด้วย Passkey / Biometrics</span>
                  </button>
                ) : null}

                {data.oauthEnabled || passkeysSupported ? (
                  <div className="aevo-sso-divider" aria-hidden="true">
                    <span>หรือใช้อีเมลและรหัสผ่าน</span>
                  </div>
                ) : null}

                {/* Form Fields */}
                <form className="aevo-sso-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
                  {mode === "register" ? (
                    <div className="aevo-form-group">
                      <label htmlFor="login-fullname" className="aevo-form-label">
                        ชื่อ-นามสกุล / ชื่อที่แสดง
                      </label>
                      <input
                        id="login-fullname"
                        type="text"
                        value={fullName}
                        onChange={(event) => setFullName(event.target.value)}
                        autoComplete="name"
                        placeholder="เช่น สมชาย ใจดี"
                        required
                        className="aevo-sso-input"
                      />
                    </div>
                  ) : null}

                  <div className="aevo-form-group">
                    <label htmlFor="login-email" className="aevo-form-label">
                      อีเมล
                    </label>
                    <input
                      id="login-email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="username"
                      placeholder="you@example.com"
                      required
                      className="aevo-sso-input"
                    />
                  </div>

                  <div className="aevo-form-group">
                    <div className="aevo-form-label-row">
                      <label htmlFor="login-password" className="aevo-form-label">
                        รหัสผ่าน
                      </label>
                      {mode === "login" ? (
                        <a className="aevo-forgot-link" href="/modern/forgot-password">
                          ลืมรหัสผ่าน?
                        </a>
                      ) : null}
                    </div>
                    <div className="aevo-input-wrapper">
                      <input
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete={mode === "register" ? "new-password" : "current-password"}
                        minLength={mode === "register" ? 12 : undefined}
                        placeholder="••••••••••••"
                        required
                        className="aevo-sso-input has-toggle"
                      />
                      <button
                        type="button"
                        className="aevo-password-toggle-btn"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
                        aria-pressed={showPassword}
                        tabIndex={0}
                      >
                        {showPassword ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
                      </button>
                    </div>
                      </div>

                  <label className="aevo-remember-row" htmlFor="login-remember-me">
                    <input
                      id="login-remember-me"
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(event) => setRememberMe(event.target.checked)}
                    />
                    <span className="aevo-remember-copy">
                      <span>จดจำอุปกรณ์นี้</span>
                      <small>ไม่ต้องเข้าสู่ระบบใหม่บนอุปกรณ์ส่วนตัว</small>
                    </span>
                  </label>

                  {mode === "register" ? (
                    <>
                      <div className="aevo-password-policy" aria-live="polite">
                        <span className={`aevo-password-meter ${passwordStrength(password).className}`}>
                          ความแข็งแรง: {passwordStrength(password).label}
                        </span>
                        <small>ใช้ 12 ตัวอักษรขึ้นไป และผสมตัวพิมพ์เล็ก/ใหญ่ ตัวเลข หรือสัญลักษณ์อย่างน้อย 3 ประเภท</small>
                      </div>

                      <div className="aevo-form-group">
                        <label htmlFor="login-confirm-password" className="aevo-form-label">
                          ยืนยันรหัสผ่าน
                        </label>
                        <div className="aevo-input-wrapper">
                          <input
                            id="login-confirm-password"
                            type={showConfirmPassword ? "text" : "password"}
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            autoComplete="new-password"
                            minLength={12}
                            placeholder="••••••••••••"
                            required
                            className="aevo-sso-input has-toggle"
                          />
                          <button
                            type="button"
                            className="aevo-password-toggle-btn"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            aria-label={showConfirmPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
                            aria-pressed={showConfirmPassword}
                            tabIndex={0}
                          >
                            {showConfirmPassword ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
                          </button>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {message ? (
                    <div className="aevo-login-alert" role="alert">
                      <AlertCircleIcon />
                      <span>{message}</span>
                    </div>
                  ) : null}

                  <button
                    className="aevo-button aevo-button--primary aevo-sso-submit-btn"
                    type="submit"
                    disabled={busy}
                  >
                    {busy ? (
                      <span className="aevo-submit-busy-state">
                        <SpinnerIcon /> กำลังตรวจสอบ…
                      </span>
                    ) : mode === "register" ? (
                      "สร้างบัญชีและเริ่มต้นใช้งาน"
                    ) : (
                      "เข้าสู่ระบบ (Sign In)"
                    )}
                  </button>
                </form>
              </>
            )}

            <p className="aevo-login-foot">
              Session เป็นแบบ app-scoped และ opaque ที่ฝั่ง Server; การเลือก “จดจำอุปกรณ์นี้” จะใช้ cookie แบบ persistent ที่มีอายุจำกัด และไม่ส่ง Supabase token ไปยัง Browser
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
