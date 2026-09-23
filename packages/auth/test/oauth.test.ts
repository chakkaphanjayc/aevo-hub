import { expect, test } from "bun:test";
import {
  AuthService,
  createOAuthFlow,
  createPasswordRecoveryFlow,
  createPasswordRecoveryGrant,
  readOAuthFlow,
  readPasswordRecoveryFlow,
  readPasswordRecoveryGrant
} from "../src";
import type { Database } from "@aevo/db";

const secret = "oauth-test-secret-oauth-test-secret-oauth-test";

test("seals and validates a short-lived OAuth flow with PKCE material", async () => {
  const created = await createOAuthFlow({
    provider: "line",
    next: "/modern",
    application: "GO",
    returnTo: "/auth/callback",
    handoffState: "handoff-state-123456",
    codeChallenge: "client-code-challenge-123456789012345678901234567890"
  }, secret);

  expect(created.flow.codeVerifier.length).toBeGreaterThanOrEqual(43);
  expect(created.codeChallenge).toHaveLength(43);
  expect(await readOAuthFlow(created.cookieValue, secret)).toEqual(created.flow);
  expect(await readOAuthFlow(created.cookieValue, "a-different-secret-a-different-secret")).toBeNull();
});

test("rejects expired or malformed OAuth flow cookies", async () => {
  const expired = await createOAuthFlow({ provider: "google", next: "/modern", ttlMs: -1 }, secret);
  expect(await readOAuthFlow(expired.cookieValue, secret)).toBeNull();
  expect(await readOAuthFlow("not-a-sealed-flow", secret)).toBeNull();
});

test("seals password recovery PKCE state and binds the short-lived grant", async () => {
  const recovery = await createPasswordRecoveryFlow(secret);
  expect(recovery.flow.codeVerifier.length).toBeGreaterThanOrEqual(43);
  expect(await readPasswordRecoveryFlow(recovery.cookieValue, secret)).toEqual(recovery.flow);

  const grant = await createPasswordRecoveryGrant({ sessionId: "session-id", userId: "user-id" }, secret);
  expect(await readPasswordRecoveryGrant(grant, secret)).toMatchObject({ sessionId: "session-id", userId: "user-id" });
  expect(await readPasswordRecoveryGrant(grant, "another-secret-another-secret-another-secret")).toBeNull();
});

test("exchanges the PKCE code through the server-side Supabase Auth endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/auth/v1/token?grant_type=pkce");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        access_token: "access-token-from-provider",
        refresh_token: "refresh-token-from-provider",
        expires_in: 3600,
        user: {
          id: "00000000-0000-0000-0000-000000000001",
          email: "oauth@example.com",
          user_metadata: { full_name: "OAuth User" }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const auth = new AuthService({} as Database);
    const result = await auth.exchangeOAuthCode({
      code: "provider-code",
      codeVerifier: "verifier",
      supabaseUrl: "https://demo.supabase.co",
      supabaseKey: "server-key"
    });
    expect(requestBody).toEqual({
      auth_code: "provider-code",
      code_verifier: "verifier"
    });
    expect(result.email).toBe("oauth@example.com");
    expect(result.displayName).toBe("OAuth User");
    expect(result.accessToken).toBe("access-token-from-provider");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
