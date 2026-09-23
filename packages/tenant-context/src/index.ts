import type {
  ApplicationCode,
  TenantContext,
  TenantContextHint
} from "@aevocado/api-contract";

const contextIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function normalizeIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !contextIdentifierPattern.test(normalized)) return undefined;
  return normalized;
}

/**
 * Normalize a client-provided hint without treating it as an authorization
 * decision. The API must resolve the result against membership and scope.
 */
export function normalizeTenantContextHint(
  hint: TenantContextHint | null | undefined
): TenantContextHint {
  return {
    ...(normalizeIdentifier(hint?.organizationId)
      ? { organizationId: normalizeIdentifier(hint?.organizationId) }
      : {}),
    ...(normalizeIdentifier(hint?.storeId)
      ? { storeId: normalizeIdentifier(hint?.storeId) }
      : {})
  };
}

export function createTenantContext(input: {
  application: ApplicationCode;
  organizationId: string;
  storeId?: string;
}): TenantContext {
  const organizationId = normalizeIdentifier(input.organizationId);
  const storeId = normalizeIdentifier(input.storeId);

  if (!organizationId) throw new Error("A valid organizationId is required");
  if (input.storeId !== undefined && !storeId) {
    throw new Error("A valid storeId is required when store context is provided");
  }

  return {
    application: input.application,
    organizationId,
    ...(storeId ? { storeId } : {}),
    scopeType: storeId ? "STORE" : "ORGANIZATION"
  };
}

export function createTenantContextKey(context: TenantContext): string {
  return ["aevocado", context.application, context.organizationId, context.storeId ?? "*"]
    .join(":");
}

export function isStoreContext(context: TenantContext): context is TenantContext & { storeId: string } {
  return context.scopeType === "STORE" && Boolean(context.storeId);
}
