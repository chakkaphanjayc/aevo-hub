import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src";

const base = {
  WEB_ORIGIN: "http://localhost:4321",
  SUPABASE_URL: "https://demo.supabase.co",
  SUPABASE_SECRET_KEY: "server-secret-server-secret-server-secret",
  SESSION_COOKIE_SECRET: "cookie-secret-cookie-secret-cookie-secret"
};

describe("loadConfig", () => {
  test("validates and normalizes Supabase environment", () => {
    const config = loadConfig({ ...base, WEB_ORIGIN: "http://localhost:4321/" });
    expect(config.apiPort).toBe(3001);
    expect(config.webOrigin).toBe("http://localhost:4321");
    expect(config.supabaseUrl).toBe("https://demo.supabase.co");
    expect(config.supabaseKey).toBe("server-secret-server-secret-server-secret");
    expect(config.sessionCookieSecret).toBe("cookie-secret-cookie-secret-cookie-secret");
    expect(config.sessionCookieSameSite).toBe("lax");
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

  test("requires an independent session secret in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", WEB_ORIGIN: "https://app.example.com", SESSION_COOKIE_SECRET: undefined })).toThrow("SESSION_COOKIE_SECRET");
  });
});
