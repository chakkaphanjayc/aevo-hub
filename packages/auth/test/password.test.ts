import { describe, expect, test } from "bun:test";
import { PASSWORD_MIN_LENGTH, validatePassword } from "../src";

describe("password policy", () => {
  test("accepts a long mixed password", () => {
    const result = validatePassword(`Aevo-${"secure"}-${"2026"}!`, "owner@example.com");
    expect(result.valid).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(3);
  });

  test("rejects short, common, whitespace, and email-derived passwords", () => {
    expect(validatePassword("short1!", "owner@example.com").valid).toBe(false);
    expect(validatePassword("password123!", "owner@example.com").valid).toBe(false);
    expect(validatePassword("Owner@example.com!", "owner@example.com").valid).toBe(false);
    expect(validatePassword(`Aevo Secure${"2026"}! `, "owner@example.com").valid).toBe(false);
  });

  test("keeps the minimum length explicit", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
  });
});
