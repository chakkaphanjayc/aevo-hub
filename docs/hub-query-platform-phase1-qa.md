# Hub Query Platform phase one QA gate

## Verdict

PASS for the committed, source-level phase-one gate. Browser and live database verification remain separate release gates.

## Evidence

- PM contract: `docs/hub-query-platform-phase1.md` on the PM worktree, commit `163a3c5`.
- Core implementation: query metadata, AST validation, tenant-scoped execution, auth/entitlement checks, export/import worker boundaries, and Core route tests on the Core worktree, commits `899fe97` and `7444db9`.
- Hub implementation: URL-backed metadata-driven Reports UI, bounded page controls, Core error states, CSRF/idempotent export submission, and explicit import/export unavailable states, commit `4c93816`.
- Core full test suite: `229 passed, 0 failed` with `RunAnalyzersDuringBuild=false`.
- Hub checks: `bun run --cwd apps/hub typecheck` and `bun run --cwd apps/hub build` passed.

## Focused checks

`bun test test/query-platform-phase1.test.ts` verifies that the Reports route:

- uses Core model metadata and bounded query execution;
- uses the existing `store.read` authorization vocabulary;
- bounds page sizes to the phase-one UI contract;
- submits exports only with CSRF and an idempotency key;
- does not render a fabricated download URL or local browser persistence;
- keeps import/export worker unavailability explicit.

Core `QueryPlatformServiceTests` and `HubQueryApiEndpointTests` cover AST version, field/operator allowlists, limit/offset/node bounds, parameter binding, stable ordering, grouping/aggregate rejection, and anonymous-session rejection for metadata, execute, export, export status, and import routes.

## Release blockers

- `query_platform` entitlement must be provisioned for a target organization before metadata/query routes can run; the Core implementation fails closed when it is absent.
- Export processing and status/download require a trusted worker, durable idempotency store, private object storage, and fresh authorization at download time.
- Imports require private upload storage, schema/mapping validation, write-scope checks, a commit worker, rollback/recovery, and audit coverage.
- No browser or deployed PostgreSQL/RLS run is claimed by this gate.
