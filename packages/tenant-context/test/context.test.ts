import { describe, expect, test } from "bun:test";
import {
  createTenantContext,
  createTenantContextKey,
  isStoreContext,
  normalizeTenantContextHint
} from "../src/index";

describe("tenant context", () => {
  test("normalizes hints without granting access", () => {
    expect(normalizeTenantContextHint({ organizationId: " org-1 ", storeId: "store-1" })).toEqual({
      organizationId: "org-1",
      storeId: "store-1"
    });
    expect(normalizeTenantContextHint({ organizationId: "//not-an-id" })).toEqual({});
  });

  test("creates stable organization and store context keys", () => {
    const context = createTenantContext({
      application: "POS",
      organizationId: "org-1",
      storeId: "store-1"
    });

    expect(context.scopeType).toBe("STORE");
    expect(isStoreContext(context)).toBe(true);
    expect(createTenantContextKey(context)).toBe("aevocado:POS:org-1:store-1");
  });
});
