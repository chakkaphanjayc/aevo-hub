import { expect, test } from "bun:test";
import { isAuthSessionCookie } from "../src";

test("accepts an opaque application session token", () => {
  expect(isAuthSessionCookie({ sessionToken: "a".repeat(43) })).toBeTrue();
});

test("rejects malformed session cookie payloads", () => {
  expect(isAuthSessionCookie(null)).toBeFalse();
  expect(isAuthSessionCookie({ accessToken: "access", refreshToken: "refresh" })).toBeFalse();
  expect(isAuthSessionCookie({ sessionToken: "" })).toBeFalse();
  expect(isAuthSessionCookie({ sessionToken: 123 })).toBeFalse();
});
