import type {
  Permission,
  PlatformPermission,
  PlatformRole,
  Role
} from "@aevo/contracts";
import { platformRolePermissionDefaults, rolePermissionDefaults } from "@aevo/contracts";

export function hasPermission(
  permissions: readonly Permission[],
  permission: Permission
): boolean {
  return permissions.includes(permission);
}

export function hasAnyPermission(
  permissions: readonly Permission[],
  required: readonly Permission[]
): boolean {
  return required.some((permission) => hasPermission(permissions, permission));
}

export function hasAllPermissions(
  permissions: readonly Permission[],
  required: readonly Permission[]
): boolean {
  return required.every((permission) => hasPermission(permissions, permission));
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return rolePermissionDefaults[role] ?? [];
}

export function hasRolePermission(role: Role, permission: Permission): boolean {
  return hasPermission(permissionsForRole(role), permission);
}

export function hasPlatformPermission(role: PlatformRole, permission: PlatformPermission): boolean {
  return (platformRolePermissionDefaults[role] ?? []).includes(permission);
}

export class PermissionDeniedError extends Error {
  readonly code = "PERMISSION_REQUIRED";

  constructor(readonly permission: Permission) {
    super(`Permission required: ${permission}`);
    this.name = "PermissionDeniedError";
  }
}

export function requirePermission(
  permissions: readonly Permission[],
  permission: Permission
): void {
  if (!hasPermission(permissions, permission)) throw new PermissionDeniedError(permission);
}
