import type {
  AccessDecisionReason,
  AppAccessDecision,
  ApplicationCode
} from "@aevocado/api-contract";

export class AccessDeniedError extends Error {
  readonly code = "APP_ACCESS_DENIED";

  constructor(readonly decision: AppAccessDecision) {
    super(`Access denied for ${decision.application}: ${decision.reason}`);
    this.name = "AccessDeniedError";
  }
}

export function isAccessAllowed(decision: AppAccessDecision): decision is AppAccessDecision & {
  allowed: true;
} {
  return decision.allowed && decision.reason === "ALLOWED";
}

export function requireAccess(
  decision: AppAccessDecision
): asserts decision is AppAccessDecision & { allowed: true } {
  if (!isAccessAllowed(decision)) throw new AccessDeniedError(decision);
}

export function createDeniedAccessDecision(input: {
  application: ApplicationCode;
  reason: Exclude<AccessDecisionReason, "ALLOWED">;
  checkedAt?: string;
}): AppAccessDecision {
  return {
    allowed: false,
    application: input.application,
    reason: input.reason,
    permissions: [],
    checkedAt: input.checkedAt ?? new Date().toISOString()
  };
}
