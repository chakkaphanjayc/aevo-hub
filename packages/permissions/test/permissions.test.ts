import { describe, expect, test } from "bun:test";
import {
  hasAllPermissions,
  hasAnyPermission,
  hasPlatformPermission,
  hasRolePermission,
  requirePermission
} from "../src/index";

describe("framework permissions", () => {
  test("supports explicit all/any checks", () => {
    const permissions = ["store.read", "order.read"] as const;
    expect(hasAllPermissions(permissions, ["store.read", "order.read"])).toBe(true);
    expect(hasAnyPermission(permissions, ["billing.manage", "order.read"])).toBe(true);
    expect(hasAllPermissions(permissions, ["store.read", "billing.manage"])).toBe(false);
  });

  test("keeps organization and platform permission domains separate", () => {
    expect(hasRolePermission("OWNER", "organization.read")).toBe(true);
    expect(hasPlatformPermission("OPS", "system.health")).toBe(true);
    expect(hasPlatformPermission("OPS", "organization.read")).toBe(false);
    expect(() => requirePermission([], "store.read")).toThrow("Permission required: store.read");
  });
});
