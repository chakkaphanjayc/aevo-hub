# Hub Query Platform Phase 1 Contract

Status: implementation contract for the first complete, tenant-safe vertical slice.

## Feature Scope

Phase 1 delivers a read-only, metadata-driven report query surface and establishes the
asynchronous export boundary without pretending that a worker or object-storage deployment
already exists.

Included:

- Query AST v1 metadata for registered, readable Hub models and fields.
- A bounded report query endpoint using the same AST as list/report/export consumers.
- Server-owned organization and store predicates, permission checks, entitlement checks, and
  bounded pagination.
- An export-job contract and durable job projection only where the existing Core/database
  authority can safely support it. A job may remain `QUEUED` until a trusted worker is deployed.
- Hub Reports UI with URL-backed query state, metadata-driven controls, real result/error states,
  and an explicit unavailable state for missing workers/providers.

Explicitly out of scope for this phase: billing checkout/portal/invoice mutations, saved-query
authoring, scheduled reports, generic imports, file upload/download URLs, provider webhooks,
worker deployment, and client-side permission or entitlement decisions.

## API Contract Definition

All routes are under `/api/v1/query`. Core resolves the app-scoped Hub session and active
organization; callers never submit an authoritative organization, store, table, SQL fragment,
permission, or quota.

### Shared QueryAstV1

```ts
type QueryAstV1 = {
  version: 1;
  model: string;
  fields: string[];
  where?: Text | Condition | And | Or | Not;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  groupBy?: string[];
  aggregates?: Array<{
    function: "count" | "sum" | "avg" | "min" | "max";
    field?: string;
    alias: string;
  }>;
  pagination: { limit: number; offset: number };
};
```

The server validates model/field/operator metadata, types, non-empty groups, aggregate
capabilities, a maximum of 64 nodes, `limit` 1..200, and a bounded offset. Unknown versions,
models, fields, operators, or unsafe values return stable structured errors. Identifiers are
allowlisted and values are parameterized. The server adds tenant predicates and a deterministic
tie-breaker before execution.

### Metadata

`GET /api/v1/query/models` returns readable active models. `GET
/api/v1/query/models/{technicalName}` returns:

```json
{
  "model": {
    "technicalName": "stores",
    "label": "Stores",
    "readPermission": "store.read",
    "fields": [
      { "path": "id", "label": "ID", "type": "uuid", "capabilities": { "filter": true, "sort": true, "export": true }, "operators": ["eq", "in"] }
    ]
  },
  "queryVersion": 1
}
```

Only metadata that the current Core authorization context may read is returned.

### Bounded report query

`POST /api/v1/query/execute` accepts `{ "query": QueryAstV1 }` and returns:

```json
{
  "queryVersion": 1,
  "columns": [{ "path": "name", "label": "Name", "type": "string" }],
  "rows": [{ "name": "Example" }],
  "page": { "limit": 50, "offset": 0, "nextOffset": null },
  "totalCount": 1
}
```

The execution order is authenticate, resolve membership and server scope, check permission,
check entitlement/quota, validate the AST, then execute and audit. A report query is read-only.

### Export job boundary

`POST /api/v1/query/exports` accepts `{ query: QueryAstV1, selectedFields: string[], format:
"CSV" | "JSON" | "XLSX" }` with an `Idempotency-Key` and returns `202 { jobId, status:
"QUEUED" }` only when Core has a durable job boundary. `GET /api/v1/query/exports/{jobId}`
returns a safe projection. A download URL is not issued until private object storage and a
trusted worker are deployed and the caller is freshly authorized. Same idempotency key plus the
same normalized fingerprint returns the existing job; a different fingerprint returns 409.

### Errors

Use the existing `{ error: { code, message, requestId, details? } }` envelope with stable codes:
`AST_VERSION_UNSUPPORTED`, `MODEL_NOT_REGISTERED`, `FIELD_NOT_ALLOWED`,
`OPERATOR_NOT_ALLOWED`, `VALUE_INVALID`, `QUERY_LIMIT_EXCEEDED`, `PERMISSION_REQUIRED`,
`ENTITLEMENT_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_CONFLICT`, and `PROVIDER_UNAVAILABLE`.

## Subtasks List

### PM / contracts

- Keep the AST and error codes versioned and mirrored in Core and Hub types.
- Record schema/worker/provider blockers; do not mark a job executable from migration presence.

### Backend

- Add strict DTOs, metadata registry, AST validator, and tenant-safe bounded execution.
- Reuse existing Hub authentication, permission, entitlement, audit, and canonical data stores.
- Add export job create/status only if idempotency and authorization can be enforced; otherwise
  return an explicit unsupported capability and document the deployment dependency.
- Add unit/integration tests for version, node/limit bounds, allowlists, tenant isolation,
  permission order, and idempotency conflict.

### Frontend

- Add Reports route and API client types with URL-backed AST state.
- Render controls from returned metadata; never hard-code hidden permissions as an authorization
  shortcut.
- Show loading, empty, validation, forbidden, unavailable, and retry states. Do not fabricate
  rows, job status, or download links.

### QA / tester

- Verify the contract against real Core route behavior and focused automated tests.
- Test cross-tenant model/field attempts, AST abuse, permission/entitlement failures, replay and
  idempotency, and worker-unavailable behavior.
- Browser verification is a separate gate and cannot be claimed from build/type checks alone.

## Acceptance Criteria

1. Given a valid Hub session and readable model, when the caller requests metadata, then Core
   returns only active fields and allowed operators for the active tenant.
2. Given a valid AST with `limit` 1..200, when a report query is submitted, then rows are read
   from canonical tenant-scoped data and the response is bounded and typed.
3. Given an unknown model, field, operator, AST version, or a query over 64 nodes, when submitted,
   then Core returns a stable 4xx error without executing SQL.
4. Given a store-scoped session, when an organization/store outside its server scope is implied
   by the request, then Core ignores the client hint or rejects it and never returns cross-scope
   rows.
5. Given no permission or entitlement, when metadata/query/export is requested, then the server
   denies it before execution; the Hub displays an honest access/unavailable state.
6. Given the same export idempotency key and normalized request, when retried, then the same job
   projection is returned; a changed request returns `IDEMPOTENCY_KEY_CONFLICT`.
7. Given no deployed worker/object storage, when an export is accepted, then it remains visibly
   queued/unavailable and the Hub does not render a fake completed file or download URL.
8. The Hub Reports screen preserves query state in the URL, supports metadata-driven filters and
   sorting, and handles loading/error/empty/permission/unavailable states accessibly.

## Definition of Done

- Core and Hub changes are committed in their own Orca worktrees with clean diffs.
- Contract types/routes are additive and documented; no raw SQL, browser secret, or client-side
  authorization shortcut is introduced.
- Backend build plus focused and relevant full tests pass, or a committed handoff identifies the
  exact external blocker and keeps the unsupported capability explicit.
- Frontend type/build checks and focused tests pass where dependencies permit; runtime/browser QA
  is reported separately with its evidence.
- QA signs off only after negative authorization, tenant isolation, AST bounds, and job
  idempotency cases are covered.
- Main worktrees remain untouched until a deliberate review/cherry-pick decision is made.

## Blockers

- Query migration/RLS parity and Core migration authority must be verified against the target
  database before production enablement.
- A trusted worker and private object storage are required before export processing or download
  URLs can be advertised.
- Billing provider checkout, portal, invoice, cancellation, and webhook contracts require a real
  provider service; this phase must not simulate payment state.
- Generic imports require private upload storage, mapping/validation/commit workers, write
  permissions, quotas, and rollback/recovery gates; they remain the next phase.
