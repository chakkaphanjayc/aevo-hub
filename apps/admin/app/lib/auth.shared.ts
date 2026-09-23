import type {
  AccessDecisionResponse,
  AuthenticatedMeResponse,
  PlatformPermission
} from "@aevocado/api-contract";

export interface AdminLoaderData {
  me: AuthenticatedMeResponse;
  access: AccessDecisionResponse;
  apiOrigin: string;
}

export function hasAdminPermission(data: AdminLoaderData, permission: PlatformPermission): boolean {
  return data.access.platformPermissions?.includes(permission) ?? false;
}
