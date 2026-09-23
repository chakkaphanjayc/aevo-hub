import type { AccessDecisionResponse, AuthenticatedMeResponse, Permission } from "@aevocado/api-contract";

export interface HubLoaderData {
  me: AuthenticatedMeResponse;
  access: AccessDecisionResponse;
  apiOrigin: string;
  homeUrl: string;
}

export function hasHubPermission(data: HubLoaderData, permission: Permission): boolean {
  return data.access.permissions.includes(permission);
}
