import type { ApplicationCode } from "@aevo/contracts";
import { applicationCodes } from "@aevo/contracts";

export type NodeEnvironment = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type SessionCookieSameSite = "lax" | "strict" | "none";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  /** First-party application boundary owning this runtime and its session. */
  applicationCode: ApplicationCode;
  /** Release identifier included in request telemetry and error context. */
  appVersion: string;
  apiHost: string;
  apiPort: number;
  webOrigin: string;
  /** Supabase project URL (for example https://<project>.supabase.co). */
  supabaseUrl: string;
  /** Server-only Supabase secret/service-role key. Never send this to browsers. */
  supabaseKey: string;
  sessionCookieName: string;
  /** HttpOnly cookie used for short-lived platform impersonation context. */
  impersonationCookieName: string;
  /** Cookie readable by the browser and echoed in X-CSRF-Token for writes. */
  csrfCookieName: string;
  /** Secret used to encrypt Supabase tokens stored in server-side sessions. */
  sessionCookieSecret: string;
  /** Sliding inactivity timeout for an application session. */
  sessionIdleTimeoutSeconds: number;
  /** Hard upper bound for an application session. */
  sessionAbsoluteTimeoutSeconds: number;
  /** Comma-separated allowlist for the platform administration surface. */
  platformAdminEmails: string[];
  /** Cookie policy used by the browser session. Defaults to lax. */
  sessionCookieSameSite?: SessionCookieSameSite;
  /** Exact browser origins allowed to use credentialed gateway routes. */
  allowedWebOrigins: string[];
  /** Public Hub callback consumed by Supabase Auth after OAuth/PKCE. */
  oauthCallbackUrl: string;
  /** HttpOnly cookie carrying the sealed OAuth state and PKCE verifier. */
  oauthStateCookieName: string;
  /** Public callback consumed by Supabase Auth after password recovery PKCE. */
  passwordRecoveryCallbackUrl: string;
  /** HttpOnly cookie carrying the sealed password-recovery PKCE verifier. */
  passwordRecoveryCookieName: string;
  /** HttpOnly cookie authorizing the short-lived password update session. */
  passwordRecoveryGrantCookieName: string;
  /** Supabase custom provider identifier used for LINE Login. */
  lineOAuthProvider: string;
  /** Whether the Hub exposes the experimental Supabase passkey flow. */
  passkeyEnabled: boolean;
  /** App-scoped customer session names used by Aevo Go. */
  goSessionCookieName: string;
  goCsrfCookieName: string;
  /** Optional private Accounts broker used while identity providers migrate. */
  accountsApiOrigin?: string;
  accountsExchangeSecret?: string;
  logLevel: LogLevel;
  stripeSecretKey?: string | undefined;
  stripeWebhookSecret?: string | undefined;
}

function required(source: Record<string, string | undefined>, key: string): string {
  const value = source[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function positiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function sessionCookieSameSite(value: string): SessionCookieSameSite {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "lax" && normalized !== "strict" && normalized !== "none") {
    throw new Error("SESSION_COOKIE_SAME_SITE must be lax, strict, or none");
  }
  return normalized;
}

function sessionCookieName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(normalized)) {
    throw new Error("SESSION_COOKIE_NAME contains invalid characters");
  }
  return normalized;
}

function absoluteHttpUrl(value: string, key: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid URL protocol");
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    throw new Error(`${key} must be a valid HTTP(S) URL`);
  }
}

function allowedWebOrigins(value: string | undefined, webOrigin: string): string[] {
  const values = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => new URL(absoluteHttpUrl(item, "AEVO_ALLOWED_WEB_ORIGINS")).origin);
  return [...new Set([webOrigin, ...values])];
}

function lineOAuthProvider(value: string | undefined): string {
  const normalized = value?.trim() || "custom:line";
  if (!/^custom:[A-Za-z0-9_-]{1,64}$/u.test(normalized)) {
    throw new Error("AEVO_LINE_OAUTH_PROVIDER must be a Supabase custom provider identifier");
  }
  return normalized;
}

function secret(value: string, key: string): string {
  const normalized = value.trim();
  if (normalized.length < 32) throw new Error(`${key} must be at least 32 characters`);
  return normalized;
}

function emailAllowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("AEVO_PASSKEY_ENABLED must be a boolean");
}

function applicationCode(value: string | undefined): ApplicationCode {
  const normalized = (value ?? "HUB").trim().toUpperCase();
  if (!applicationCodes.includes(normalized as ApplicationCode)) {
    throw new Error(`AEVO_APP_CODE must be one of: ${applicationCodes.join(", ")}`);
  }
  return normalized as ApplicationCode;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) throw new Error("NODE_ENV is invalid");
  const logLevel = source.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL is invalid");
  const webOrigin = required(source, "WEB_ORIGIN");
  const supabaseUrl = required(source, "SUPABASE_URL");
  const supabaseKey = source.SUPABASE_SECRET_KEY?.trim();
  if (!supabaseKey) throw new Error("Missing required environment variable: SUPABASE_SECRET_KEY");
  let normalizedWebOrigin: string;
  let normalizedSupabaseUrl: string;
  try {
    const parsedWebOrigin = new URL(webOrigin);
    if (parsedWebOrigin.protocol !== "https:" && parsedWebOrigin.protocol !== "http:") throw new Error("invalid web protocol");
    const parsedSupabaseUrl = new URL(supabaseUrl);
    if (parsedSupabaseUrl.protocol !== "https:" && parsedSupabaseUrl.protocol !== "http:") {
      throw new Error("invalid Supabase protocol");
    }
    normalizedWebOrigin = parsedWebOrigin.origin;
    normalizedSupabaseUrl = parsedSupabaseUrl.toString().replace(/\/$/, "");
  } catch {
    throw new Error("WEB_ORIGIN and SUPABASE_URL must be valid URLs");
  }
  if (nodeEnv === "production" && (!normalizedWebOrigin.startsWith("https://") || !normalizedSupabaseUrl.startsWith("https://"))) {
    throw new Error("Production WEB_ORIGIN and SUPABASE_URL must use HTTPS");
  }
  const configuredOAuthCallbackUrl = source.AEVO_HUB_OAUTH_CALLBACK_URL?.trim()
    || `${normalizedWebOrigin}/api/auth/oauth/callback`;
  const oauthCallbackUrl = absoluteHttpUrl(configuredOAuthCallbackUrl, "AEVO_HUB_OAUTH_CALLBACK_URL");
  if (nodeEnv === "production" && !oauthCallbackUrl.startsWith("https://")) {
    throw new Error("Production AEVO_HUB_OAUTH_CALLBACK_URL must use HTTPS");
  }
  const configuredPasswordRecoveryCallbackUrl = source.AEVO_PASSWORD_RECOVERY_CALLBACK_URL?.trim()
    || `${normalizedWebOrigin}/api/auth/password/recovery/callback`;
  const passwordRecoveryCallbackUrl = absoluteHttpUrl(configuredPasswordRecoveryCallbackUrl, "AEVO_PASSWORD_RECOVERY_CALLBACK_URL");
  if (nodeEnv === "production" && !passwordRecoveryCallbackUrl.startsWith("https://")) {
    throw new Error("Production AEVO_PASSWORD_RECOVERY_CALLBACK_URL must use HTTPS");
  }
  const accountsApiOrigin = source.AEVO_ACCOUNTS_API_ORIGIN?.trim()
    ? absoluteHttpUrl(source.AEVO_ACCOUNTS_API_ORIGIN, "AEVO_ACCOUNTS_API_ORIGIN")
    : undefined;
  const accountsExchangeSecret = source.AEVO_ACCOUNTS_EXCHANGE_SECRET?.trim() || undefined;
  const configuredCookieSameSite = sessionCookieSameSite(source.SESSION_COOKIE_SAME_SITE ?? "lax");
  if (configuredCookieSameSite === "none" && nodeEnv !== "production") {
    throw new Error("SESSION_COOKIE_SAME_SITE=none requires NODE_ENV=production and HTTPS");
  }
  const configuredSessionSecret = source.SESSION_COOKIE_SECRET?.trim();
  if (nodeEnv === "production" && !configuredSessionSecret) {
    throw new Error("SESSION_COOKIE_SECRET is required in production");
  }
  return {
    nodeEnv: nodeEnv as NodeEnvironment,
    applicationCode: applicationCode(source.AEVO_APP_CODE),
    appVersion: source.APP_VERSION?.trim() || "development",
    apiHost: source.API_HOST ?? "0.0.0.0",
    apiPort: positiveInteger(source.API_PORT ?? "3001", "API_PORT"),
    webOrigin: normalizedWebOrigin!,
    supabaseUrl: normalizedSupabaseUrl!,
    supabaseKey,
    sessionCookieName: sessionCookieName(source.SESSION_COOKIE_NAME ?? "aevo_session"),
    impersonationCookieName: sessionCookieName(source.IMPERSONATION_COOKIE_NAME ?? "aevo_impersonation"),
    csrfCookieName: sessionCookieName(source.CSRF_COOKIE_NAME ?? "aevo_csrf"),
    sessionCookieSecret: secret(configuredSessionSecret || supabaseKey, "SESSION_COOKIE_SECRET"),
    sessionIdleTimeoutSeconds: positiveInteger(source.SESSION_IDLE_TIMEOUT_SECONDS ?? String(60 * 60 * 24 * 30), "SESSION_IDLE_TIMEOUT_SECONDS"),
    sessionAbsoluteTimeoutSeconds: positiveInteger(source.SESSION_ABSOLUTE_TIMEOUT_SECONDS ?? String(60 * 60 * 24 * 90), "SESSION_ABSOLUTE_TIMEOUT_SECONDS"),
    platformAdminEmails: emailAllowlist(source.PLATFORM_ADMIN_EMAILS),
    sessionCookieSameSite: configuredCookieSameSite,
    allowedWebOrigins: allowedWebOrigins(source.AEVO_ALLOWED_WEB_ORIGINS, normalizedWebOrigin),
    oauthCallbackUrl,
    oauthStateCookieName: sessionCookieName(source.AEVO_OAUTH_STATE_COOKIE_NAME ?? "aevo_hub_oauth_state"),
    passwordRecoveryCallbackUrl,
    passwordRecoveryCookieName: sessionCookieName(source.AEVO_PASSWORD_RECOVERY_COOKIE_NAME ?? "aevo_password_recovery"),
    passwordRecoveryGrantCookieName: sessionCookieName(source.AEVO_PASSWORD_RECOVERY_GRANT_COOKIE_NAME ?? "aevo_password_recovery_grant"),
    lineOAuthProvider: lineOAuthProvider(source.AEVO_LINE_OAUTH_PROVIDER),
    passkeyEnabled: booleanValue(source.AEVO_PASSKEY_ENABLED, true),
    goSessionCookieName: sessionCookieName(source.AEVO_GO_SESSION_COOKIE_NAME ?? "aevo_go_session"),
    goCsrfCookieName: sessionCookieName(source.AEVO_GO_CSRF_COOKIE_NAME ?? "aevo_go_csrf"),
    ...(accountsApiOrigin ? { accountsApiOrigin } : {}),
    ...(accountsExchangeSecret ? { accountsExchangeSecret } : {}),
    logLevel: logLevel as LogLevel,
    stripeSecretKey: source.STRIPE_SECRET_KEY?.trim() || undefined,
    stripeWebhookSecret: source.STRIPE_WEBHOOK_SECRET?.trim() || undefined
  };
}
