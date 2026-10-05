export interface UnexposedCoreCapability {
  state: "unavailable";
  code: string;
  message: string;
}

export const unexposedCapabilities = {
  billingPortal: {
    state: "unavailable",
    code: "CORE_BILLING_PORTAL_NOT_EXPOSED",
    message: "Core does not expose billing-provider portal capability or a portal action to Hub.",
  },
  paymentHistory: {
    state: "unavailable",
    code: "CORE_BILLING_HISTORY_NOT_EXPOSED",
    message: "Core does not expose payment methods, invoices, or transaction history to Hub.",
  },
  queryPlatform: {
    state: "unavailable",
    code: "CORE_QUERY_PLATFORM_NOT_EXPOSED",
    message: "Core does not expose Query Platform model metadata, saved definitions, report execution, or export jobs to Hub.",
  },
  imports: {
    state: "unavailable",
    code: "CORE_IMPORT_CAPABILITY_NOT_EXPOSED",
    message: "Core does not expose import schemas, field-mapping metadata, validation, or import jobs to Hub.",
  },
  exports: {
    state: "unavailable",
    code: "CORE_EXPORT_CAPABILITY_NOT_EXPOSED",
    message: "Core does not expose scoped export metadata, export jobs, or result downloads to Hub.",
  },
} satisfies Record<string, UnexposedCoreCapability>;
