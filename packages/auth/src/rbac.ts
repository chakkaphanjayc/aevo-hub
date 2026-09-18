import type {
  Permission,
  PlatformPermission,
  PlatformRole,
  SessionPrincipal
} from "@aevo/contracts";
import { platformRolePermissionDefaults } from "@aevo/contracts";

export function hasPermission(principal: SessionPrincipal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

export function requirePermission(principal: SessionPrincipal, permission: Permission): void {
  if (!hasPermission(principal, permission)) throw new AuthorizationError(permission);
}

export function isOrganizationOwner(principal: SessionPrincipal): boolean {
  return principal.role === "OWNER";
}

export function canTransferOwnership(principal: SessionPrincipal): boolean {
  return principal.role === "OWNER" && principal.permissions.includes("organization.ownership.transfer");
}

export function canDeleteOrganization(principal: SessionPrincipal): boolean {
  return principal.role === "OWNER" && principal.permissions.includes("organization.delete");
}

export function canManageBilling(principal: SessionPrincipal): boolean {
  return principal.role === "OWNER" || principal.permissions.includes("billing.manage");
}

export class AuthorizationError extends Error {
  readonly code = "FORBIDDEN";
  constructor(readonly permission: Permission) {
    super(`Permission required: ${permission}`);
    this.name = "AuthorizationError";
  }
}

export function hasPlatformPermission(role: PlatformRole, permission: PlatformPermission): boolean {
  if (role === "SUPER_ADMIN") return true;
  const perms = platformRolePermissionDefaults[role] ?? [];
  return perms.includes(permission);
}

export function requirePlatformPermission(role: PlatformRole, permission: PlatformPermission): void {
  if (!hasPlatformPermission(role, permission)) {
    throw new PlatformAuthorizationError(role, permission);
  }
}

export class PlatformAuthorizationError extends Error {
  readonly code = "FORBIDDEN";
  constructor(readonly role: PlatformRole, readonly permission: PlatformPermission) {
    super(`Platform permission '${permission}' required. Current role: ${role}`);
    this.name = "PlatformAuthorizationError";
  }
}
