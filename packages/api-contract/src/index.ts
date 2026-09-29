import { applicationCodes } from "@aevocado/contracts";
import type {
  ApiErrorBody,
  ApplicationCode,
  ApplicationConnectionTestResponse,
  ApplicationHandshakeResponse,
  HubApplicationLaunch,
  HubApplicationLaunchResponse,
  HubEntitlementCheckResponse,
  MemberApplicationAssignmentSummary,
  StoreApplicationAccessSummary,
  StoreTemplateSummary
} from "@aevocado/contracts";

export type {
  ApiErrorBody,
  ApplicationCode,
  ApplicationConnectionTestResponse,
  ApplicationHandshakeResponse,
  HubApplicationLaunch,
  HubApplicationLaunchResponse,
  HubEntitlementCheckResponse,
  MemberApplicationAssignmentSummary,
  StoreApplicationAccessSummary,
  StoreTemplateSummary
} from "@aevocado/contracts";

export const apiContractVersion = 1 as const;

export type Permission = string;
export type Role = string;
export type PlatformPermission = string;
export type ApplicationAssignmentStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";
export type ApplicationScopeType = "ORGANIZATION" | "STORE" | "RESOURCE" | "DEVICE_GROUP";
export type StoreApplicationCode = "PLAY" | "POS" | "KIOSK" | "QUEUE";
export type StoreApplicationStatus = "ACTIVE" | "DISABLED";

export interface ApplicationScopeSummary {
  scopeType: ApplicationScopeType;
  scopeRef: string;
}

export interface TenantContextHint {
  organizationId?: string;
  storeId?: string;
}

export interface TenantContext {
  application: ApplicationCode;
  organizationId: string;
  storeId?: string;
  scopeType: "ORGANIZATION" | "STORE";
}

export interface ApiRequestContext {
  requestId: string;
  application: ApplicationCode;
  appVersion: string;
  environment: "development" | "test" | "production";
  organizationId?: string;
  storeId?: string;
}

export interface IdempotencyMetadata {
  key: string;
  scope: string;
}

export type AccessDecisionReason =
  | "ALLOWED"
  | "AUTHENTICATION_REQUIRED"
  | "ACCOUNT_DISABLED"
  | "MEMBERSHIP_REQUIRED"
  | "APP_ASSIGNMENT_REQUIRED"
  | "APP_ASSIGNMENT_SUSPENDED"
  | "SCOPE_REQUIRED"
  | "STORE_APPLICATION_DISABLED"
  | "PERMISSION_REQUIRED"
  | "APPLICATION_DISABLED"
  | "ENTITLEMENT_INACTIVE"
  | "ENTITLEMENT_REQUIRED"
  | "ENTITLEMENT_EXPIRED"
  | "APP_NOT_REGISTERED"
  | "ENTITLEMENT_PROJECTION_UNAVAILABLE"
  | "DEVELOPMENT_BYPASS_FORBIDDEN";

export type ApplicationLaunchReason =
  | AccessDecisionReason
  | "APPLICATION_NOT_READY"
  | "APP_ORIGIN_NOT_CONFIGURED"
  | "LAUNCH_NOT_SUPPORTED";

export interface AppAccessDecision {
  allowed: boolean;
  application: ApplicationCode;
  reason: AccessDecisionReason;
  userId?: string;
  organizationId?: string;
  storeId?: string;
  role?: Role;
  permissions: Permission[];
  platformRole?: string;
  platformPermissions?: PlatformPermission[];
  checkedAt: string;
}

export interface AccessDecisionResponse extends AppAccessDecision {
  context?: TenantContext;
}

export interface AuthenticatedMeResponse {
  user: {
    id: string;
    email: string;
    displayName?: string;
  };
  principal: {
    userId: string;
    email: string;
    displayName?: string;
    organizationId: string;
    membershipId: string;
    role: Role;
    permissions: Permission[];
  } | null;
  access?: AccessDecisionResponse;
}

export function isApplicationCode(value: unknown): value is ApplicationCode {
  return typeof value === "string" && applicationCodes.includes(value as ApplicationCode);
}

export function isTenantContextHint(value: unknown): value is TenantContextHint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.organizationId === undefined || typeof candidate.organizationId === "string")
    && (candidate.storeId === undefined || typeof candidate.storeId === "string");
}

/** Only same-origin relative paths are valid login return paths. */
export function isSafeReturnPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.startsWith("/") && !decoded.startsWith("//") && !decoded.includes("\\");
  } catch {
    return false;
  }
}

export function safeReturnPath(value: unknown, fallback = "/"): string {
  return isSafeReturnPath(value) ? value : fallback;
}
