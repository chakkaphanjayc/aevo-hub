import { describe, expect, test } from "bun:test";
import { ApiClient } from "@aevocado/contracts";
import { createAuthClient } from "../src";

describe("@aevocado/auth-client", () => {
  test("builds an app-aware sign-in redirect without exposing tokens", () => {
    const client = createAuthClient({
      api: new ApiClient({ baseUrl: "http://localhost:4000", fetcher: async () => new Response(null, { status: 204 }) }),
      application: "HUB"
    });
    expect(client.signInRedirect({ returnPath: "/workspace?storeId=store-1" })).toBe(
      "/login?app=HUB&returnTo=%2Fworkspace%3FstoreId%3Dstore-1"
    );
    expect(client.signInRedirect({ returnPath: "https://evil.example" })).toBe("/login?app=HUB&returnTo=%2F");
  });

  test("provides the CSRF header for cookie-session mutations", async () => {
    let csrfHeader = "";
    const client = createAuthClient({
      api: new ApiClient({
        baseUrl: "http://localhost:4000",
        fetcher: async (_input, init) => {
          csrfHeader = new Headers(init?.headers).get("x-csrf-token") ?? "";
          return new Response(null, { status: 204 });
        }
      }),
      application: "HUB",
      csrfToken: () => "csrf-token"
    });

    await client.refresh();
    expect(csrfHeader).toBe("csrf-token");
  });
});
