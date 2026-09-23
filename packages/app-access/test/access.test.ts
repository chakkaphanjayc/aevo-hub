import { describe, expect, test } from "bun:test";
import {
  AccessDeniedError,
  createDeniedAccessDecision,
  isAccessAllowed,
  requireAccess
} from "../src/index";

describe("application access", () => {
  test("keeps denied decisions explicit", () => {
    const decision = createDeniedAccessDecision({
      application: "POS",
      reason: "APP_ASSIGNMENT_REQUIRED",
      checkedAt: "2026-09-19T00:00:00.000Z"
    });

    expect(isAccessAllowed(decision)).toBe(false);
    expect(() => requireAccess(decision)).toThrow(AccessDeniedError);
    expect(decision.permissions).toEqual([]);
  });

  test("accepts only an allowed decision", () => {
    const decision = {
      allowed: true,
      application: "HUB" as const,
      reason: "ALLOWED" as const,
      permissions: ["organization.read" as const],
      checkedAt: "2026-09-19T00:00:00.000Z"
    };

    expect(isAccessAllowed(decision)).toBe(true);
    expect(() => requireAccess(decision)).not.toThrow();
  });
});
