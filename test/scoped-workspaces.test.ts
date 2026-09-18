import { beforeAll, describe, expect, it } from "bun:test";
import {
  canDeleteOrganization,
  canManageBilling,
  canTransferOwnership,
  hasPermission,
  isOrganizationOwner
} from "@aevo/auth";
import type { SessionPrincipal } from "@aevo/contracts";
import {
  createDatabase,
  createInvitation,
  getOrganizationOverviewMetrics,
  getStoreOverviewMetrics,
  listInvitations,
  revokeInvitation
} from "@aevo/db";

describe("Scoped Workspaces & 4-Tier RBAC Architecture", () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required for scoped workspace tests");

  const database = createDatabase(
    supabaseUrl,
    supabaseKey
  );

  let testOrgId: string;
  let testStoreId: string;
  let ownerPrincipal: SessionPrincipal;
  let storeManagerPrincipal: SessionPrincipal;
  const timestamp = Date.now();

  beforeAll(async () => {
    const storeRes = await database.client
      .from("stores")
      .select("id, organization_id, name, code")
      .eq("status", "ACTIVE")
      .order("created_at", { ascending: false })
      .limit(1);

    const activeStore = storeRes.data?.[0];
    if (storeRes.error || !activeStore) throw new Error(`Unable to resolve an active store: ${storeRes.error?.message ?? "not found"}`);
    testStoreId = activeStore.id;
    testOrgId = activeStore.organization_id;

    const memRes = await database.client
      .from("memberships")
      .select("user_id")
      .eq("organization_id", testOrgId)
      .limit(1);

    const membership = memRes.data?.[0];
    if (memRes.error || !membership) throw new Error(`Unable to resolve an organization member: ${memRes.error?.message ?? "not found"}`);
    const realUserId = membership.user_id;

    ownerPrincipal = {
      userId: realUserId,
      email: `owner.${timestamp}@aevo.test`,
      organizationId: testOrgId,
      membershipId: "mem-1",
      role: "OWNER",
      permissions: [
        "organization.manage",
        "organization.read",
        "organization.update",
        "organization.delete",
        "organization.ownership.transfer",
        "billing.manage",
        "store.read",
        "store.manage",
        "member.manage",
        "member.invite",
        "order.read",
        "catalog.read"
      ]
    };

    storeManagerPrincipal = {
      userId: crypto.randomUUID(),
      email: `store.mgr.${timestamp}@aevo.test`,
      organizationId: testOrgId,
      membershipId: "mem-2",
      role: "STORE_MANAGER",
      permissions: [
        "store.read",
        "store.manage",
        "order.read",
        "order.create",
        "member.manage",
        "member.invite"
      ]
    };
  });

  it("1. Verifies Owner-exclusive invariants in RBAC", () => {
    // Owner has exclusive powers
    expect(isOrganizationOwner(ownerPrincipal)).toBeTrue();
    expect(canTransferOwnership(ownerPrincipal)).toBeTrue();
    expect(canDeleteOrganization(ownerPrincipal)).toBeTrue();
    expect(canManageBilling(ownerPrincipal)).toBeTrue();

    // Store Manager does NOT have organization ownership, deletion, or billing
    expect(isOrganizationOwner(storeManagerPrincipal)).toBeFalse();
    expect(canTransferOwnership(storeManagerPrincipal)).toBeFalse();
    expect(canDeleteOrganization(storeManagerPrincipal)).toBeFalse();
    expect(canManageBilling(storeManagerPrincipal)).toBeFalse();
  });

  it("2. Organization Overview Metrics: returns multi-store brand pulse without terminals as primary KPI", async () => {
    const stats = await getOrganizationOverviewMetrics(database, testOrgId);

    expect(stats.totalStores).toBeGreaterThanOrEqual(1);
    expect(stats.activeApps).toBeGreaterThanOrEqual(0);
    expect(stats.totalMembers).toBeGreaterThanOrEqual(1);
    expect(typeof stats.todayRevenueMinor).toBe("number");
    expect(typeof stats.monthRevenueMinor).toBe("number");
    expect(Array.isArray(stats.storePerformance)).toBeTrue();

    const firstStore = stats.storePerformance[0];
    expect(firstStore).toBeDefined();
    expect(firstStore.storeId).toBeDefined();
    expect(firstStore.name).toBeDefined();
    expect(firstStore.code).toBeDefined();
    expect(typeof firstStore.todayRevenueMinor).toBe("number");
    expect(typeof firstStore.todayOrdersCount).toBe("number");
  });

  it("3. Store Overview Metrics: returns branch-specific operational metrics and hardware connectivity", async () => {
    const stats = await getStoreOverviewMetrics(database, testOrgId, testStoreId);

    expect(stats.storeId).toBe(testStoreId);
    expect(stats.name).toBeDefined();
    expect(stats.code).toBeDefined();
    expect(typeof stats.todaySalesMinor).toBe("number");
    expect(typeof stats.todayOrders).toBe("number");
    expect(typeof stats.todayBookings).toBe("number");
    expect(typeof stats.devicesOnline).toBe("number");
    expect(typeof stats.devicesTotal).toBe("number");
  });

  it("4. Scoped Invitations: enforces delegation hierarchy and store scoping", async () => {
    const inviteEmail = `invited.staff.${timestamp}@aevo.test`;

    // A. Owner can invite Store Manager
    const storeInvite = await createInvitation(database, ownerPrincipal, {
      email: inviteEmail,
      role: "STORE_MANAGER",
      scopeType: "STORE",
      storeId: testStoreId
    });

    expect(storeInvite.id).toBeDefined();
    expect(storeInvite.email).toBe(inviteEmail);
    expect(storeInvite.roleCode).toBe("STORE_MANAGER");
    expect(storeInvite.scopeType).toBe("STORE");
    expect(storeInvite.storeId).toBe(testStoreId);
    expect(storeInvite.status).toBe("PENDING");

    // B. Rejection: Owner cannot invite OWNER (transfer required)
    await expect(createInvitation(database, ownerPrincipal, {
      email: `fail.owner.${timestamp}@aevo.test`,
      role: "OWNER",
      scopeType: "ORGANIZATION"
    })).rejects.toThrow("ownership");

    // C. Rejection: Store Manager cannot invite managerial roles
    await expect(createInvitation(database, storeManagerPrincipal, {
      email: `fail.admin.${timestamp}@aevo.test`,
      role: "ORGANIZATION_MANAGER",
      scopeType: "ORGANIZATION"
    })).rejects.toThrow();

    // D. List and Revoke
    const invites = await listInvitations(database, ownerPrincipal, testStoreId);
    const found = invites.find((i) => i.id === storeInvite.id);
    expect(found).toBeDefined();

    const revoked = await revokeInvitation(database, ownerPrincipal, storeInvite.id);
    expect(revoked).toBeTrue();
  });
});
