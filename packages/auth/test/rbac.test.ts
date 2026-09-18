import { describe, expect, test } from "bun:test";
import type { SessionPrincipal } from "@aevo/contracts";
import {
  canDeleteOrganization,
  canManageBilling,
  canTransferOwnership,
  hasPermission,
  isOrganizationOwner,
  requirePermission
} from "../src";

const principal: SessionPrincipal = {
  userId: "user", email: "cashier@example.com", organizationId: "org",
  membershipId: "membership", role: "CASHIER",
  permissions: ["store.read", "order.create", "payment.receive"]
};

describe("RBAC", () => {
  test("allows granted permissions", () => expect(hasPermission(principal, "order.create")).toBeTrue());
  test("rejects sensitive ungranted operations", () => {
    expect(() => requirePermission(principal, "refund.create")).toThrow("refund.create");
  });

  test("OWNER has exclusive authority for deletion and ownership transfer", () => {
    const ownerPrincipal: SessionPrincipal = {
      userId: "u1", email: "owner@aevo.test", organizationId: "org1",
      membershipId: "m1", role: "OWNER",
      permissions: ["organization.delete", "organization.ownership.transfer", "billing.manage"]
    };
    const orgManagerPrincipal: SessionPrincipal = {
      userId: "u2", email: "manager@aevo.test", organizationId: "org1",
      membershipId: "m2", role: "ORGANIZATION_MANAGER",
      permissions: ["organization.read", "organization.update", "store.manage"]
    };
    const storeManagerPrincipal: SessionPrincipal = {
      userId: "u3", email: "sm@aevo.test", organizationId: "org1",
      membershipId: "m3", role: "STORE_MANAGER",
      permissions: ["store.read", "store.manage", "order.create"]
    };

    // Owner checks
    expect(isOrganizationOwner(ownerPrincipal)).toBeTrue();
    expect(canDeleteOrganization(ownerPrincipal)).toBeTrue();
    expect(canTransferOwnership(ownerPrincipal)).toBeTrue();
    expect(canManageBilling(ownerPrincipal)).toBeTrue();

    // Org Manager cannot delete or transfer
    expect(isOrganizationOwner(orgManagerPrincipal)).toBeFalse();
    expect(canDeleteOrganization(orgManagerPrincipal)).toBeFalse();
    expect(canTransferOwnership(orgManagerPrincipal)).toBeFalse();
    expect(canManageBilling(orgManagerPrincipal)).toBeFalse();

    // Store Manager cannot delete or transfer
    expect(isOrganizationOwner(storeManagerPrincipal)).toBeFalse();
    expect(canDeleteOrganization(storeManagerPrincipal)).toBeFalse();
    expect(canTransferOwnership(storeManagerPrincipal)).toBeFalse();
    expect(canManageBilling(storeManagerPrincipal)).toBeFalse();
  });
});
