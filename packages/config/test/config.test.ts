import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src";

const base = {
  WEB_ORIGIN: "http://localhost:4330",
  SUPABASE_URL: "https://demo.supabase.co",
  SUPABASE_SECRET_KEY: "server-secret-server-secret-server-secret",
  SESSION_COOKIE_SECRET: "cookie-secret-cookie-secret-cookie-secret"
};

describe("loadConfig", () => {
  test("validates and normalizes Supabase environment", () => {
    const config = loadConfig({ ...base, WEB_ORIGIN: "http://localhost:4330/" });
    expect(config.apiPort).toBe(3001);
    expect(config.applicationCode).toBe("HUB");
    expect(config.appVersion).toBe("development");
    expect(config.webOrigin).toBe("http://localhost:4330");
    expect(config.supabaseUrl).toBe("https://demo.supabase.co");
    expect(config.supabaseKey).toBe("server-secret-server-secret-server-secret");
    expect(config.sessionCookieSecret).toBe("cookie-secret-cookie-secret-cookie-secret");
    expect(config.sessionCookieSameSite).toBe("lax");
    expect(config.oauthCallbackUrl).toBe("http://localhost:4330/api/auth/oauth/callback");
    expect(config.passwordRecoveryCallbackUrl).toBe("http://localhost:4330/api/auth/password/recovery/callback");
    expect(config.passwordRecoveryCookieName).toBe("aevo_password_recovery");
    expect(config.passwordRecoveryGrantCookieName).toBe("aevo_password_recovery_grant");
    expect(config.lineOAuthProvider).toBe("custom:line");
    expect(config.passkeyEnabled).toBe(true);
    expect(config.allowedWebOrigins).toEqual(["http://localhost:4330"]);
    expect(config.goSessionCookieName).toBe("aevo_go_session");
  });

  test("rejects the removed service-role secret alias", () => {
    expect(() => loadConfig({ WEB_ORIGIN: base.WEB_ORIGIN, SUPABASE_URL: base.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: "old-secret-old-secret-old-secret" })).toThrow("SUPABASE_SECRET_KEY");
  });

  test("rejects missing database configuration", () => {
    expect(() => loadConfig({ WEB_ORIGIN: base.WEB_ORIGIN })).toThrow("SUPABASE_URL");
    expect(() => loadConfig({ WEB_ORIGIN: base.WEB_ORIGIN, SUPABASE_URL: base.SUPABASE_URL })).toThrow("SUPABASE_SECRET_KEY");
  });

  test("rejects non-HTTP Supabase URLs", () => {
    expect(() => loadConfig({ ...base, SUPABASE_URL: "postgres://db/app" })).toThrow("SUPABASE_URL");
  });

  test("validates the session cookie policy and name", () => {
    const config = loadConfig({ ...base, SESSION_COOKIE_SAME_SITE: "strict", SESSION_COOKIE_NAME: "aevo_staff" });
    expect(config.sessionCookieSameSite).toBe("strict");
    expect(config.sessionCookieName).toBe("aevo_staff");
    expect(() => loadConfig({ ...base, SESSION_COOKIE_SAME_SITE: "cross-site" })).toThrow("SESSION_COOKIE_SAME_SITE");
    expect(() => loadConfig({ ...base, SESSION_COOKIE_SAME_SITE: "none" })).toThrow("NODE_ENV=production");
  });

  test("validates the application boundary and release metadata", () => {
    const config = loadConfig({ ...base, AEVO_APP_CODE: "play", APP_VERSION: "2026.09.19" });
    expect(config.applicationCode).toBe("PLAY");
    expect(config.appVersion).toBe("2026.09.19");
    expect(() => loadConfig({ ...base, AEVO_APP_CODE: "UNKNOWN" })).toThrow("AEVO_APP_CODE");
  });

  test("supports the isolated Admin application runtime", () => {
    const config = loadConfig({
      ...base,
      AEVO_APP_CODE: "ADMIN",
      API_PORT: "4001",
      WEB_ORIGIN: "http://localhost:4335",
      AEVO_ALLOWED_WEB_ORIGINS: "http://localhost:4335",
      SESSION_COOKIE_NAME: "aevo_admin_session",
      CSRF_COOKIE_NAME: "aevo_admin_csrf"
    });
    expect(config.applicationCode).toBe("ADMIN");
    expect(config.apiPort).toBe(4001);
    expect(config.webOrigin).toBe("http://localhost:4335");
    expect(config.sessionCookieName).toBe("aevo_admin_session");
    expect(config.csrfCookieName).toBe("aevo_admin_csrf");
    expect(config.allowedWebOrigins).toEqual(["http://localhost:4335"]);
  });

  test("requires an independent session secret in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", WEB_ORIGIN: "https://app.example.com", SESSION_COOKIE_SECRET: undefined })).toThrow("SESSION_COOKIE_SECRET");
  });

  test("normalizes credentialed origins and validates OAuth provider settings", () => {
    const config = loadConfig({
      ...base,
      AEVO_ALLOWED_WEB_ORIGINS: "http://localhost:4324, http://localhost:4330/",
      AEVO_HUB_OAUTH_CALLBACK_URL: "http://localhost:4330/api/auth/oauth/callback/",
      AEVO_PASSWORD_RECOVERY_CALLBACK_URL: "http://localhost:4330/api/auth/password/recovery/callback/",
      AEVO_LINE_OAUTH_PROVIDER: "custom:line-login"
    });
    expect(config.allowedWebOrigins).toEqual(["http://localhost:4330", "http://localhost:4324"]);
    expect(config.oauthCallbackUrl).toBe("http://localhost:4330/api/auth/oauth/callback");
    expect(config.passwordRecoveryCallbackUrl).toBe("http://localhost:4330/api/auth/password/recovery/callback");
    expect(config.lineOAuthProvider).toBe("custom:line-login");
    expect(() => loadConfig({ ...base, AEVO_LINE_OAUTH_PROVIDER: "line" })).toThrow("AEVO_LINE_OAUTH_PROVIDER");
    expect(loadConfig({ ...base, AEVO_PASSKEY_ENABLED: "false" }).passkeyEnabled).toBe(false);
    expect(() => loadConfig({ ...base, AEVO_PASSKEY_ENABLED: "maybe" })).toThrow("AEVO_PASSKEY_ENABLED");
  });
});
