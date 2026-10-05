import { ApiClientError } from "@aevocado/contracts";
import { Button, StatusBadge } from "@aevocado/design-system";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { isAccessAllowed } from "@aevocado/app-access";
import { CapabilityNotice, PlatformPage } from "../components/platform-settings";
import {
  createHubApiClient,
  requestCsrfHeaders,
  requireHubAccess,
} from "../lib/auth.server";
import type { HubLoaderData } from "../lib/auth.shared";
import "../platform-settings.css";

export function meta() {
  return [{ title: "Reports | Aevo Hub" }];
}

type CoreRead<T> =
  | { state: "available"; data: T }
  | { state: "denied" | "unavailable" | "error"; code: string; message: string };

interface QueryFieldCapabilities {
  search: boolean;
  filter: boolean;
  sort: boolean;
  group: boolean;
  export: boolean;
  import: boolean;
  aggregate: boolean;
}

interface QueryFieldMetadata {
  path: string;
  label: string;
  type: string;
  capabilities: QueryFieldCapabilities;
  operators: string[];
}

interface QueryModelMetadata {
  technicalName: string;
  label: string;
  tenantScope: string;
  readPermission: string;
  defaultSearchFields: string[];
  defaultOrder: Array<{ field: string; direction: "asc" | "desc" }>;
  fields: QueryFieldMetadata[];
  relations: Array<{ path: string; targetModel: string; cardinality: string }>;
}

interface QueryModelsResponse {
  version: number;
  models: QueryModelMetadata[];
}

interface QueryFilterNode {
  type: "text" | "condition" | "and" | "or" | "not";
  field?: string;
  operator?: string;
  value?: string | string[];
  children?: QueryFilterNode[];
}

interface QueryAstV1 {
  version: 1;
  model: string;
  fields: string[];
  where?: QueryFilterNode;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  pagination: { limit: number; offset: number };
}

interface QueryExecutionResponse {
  queryVersion: number;
  columns: Array<{ path: string; label: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  page: { limit: number; offset: number; nextOffset: number | null; hasMore: boolean };
}

interface ReportQueryState {
  model: string;
  q: string;
  filterField: string;
  filterOperator: string;
  filterValue: string;
  sort: string;
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
}

interface ReportsLoaderData {
  hub: HubLoaderData;
  models: CoreRead<QueryModelsResponse>;
  selectedModel: QueryModelMetadata | null;
  query: ReportQueryState;
  ast: QueryAstV1 | null;
  result: CoreRead<QueryExecutionResponse> | null;
}

interface ReportActionData {
  state: "success" | "unavailable" | "denied" | "error";
  code: string;
  message: string;
}

const allowedPageSizes = [10, 25, 50, 100] as const;
const valueLessOperators = new Set(["is_empty", "is_not_empty"]);
const listOperators = new Set(["in", "not_in"]);

function readCoreError(error: unknown): Exclude<CoreRead<never>, { state: "available" }> {
  if (error instanceof ApiClientError) {
    if (error.status === 401 || error.status === 403) {
      return { state: "denied", code: error.code || "PERMISSION_REQUIRED", message: error.message };
    }
    if (error.status === 404 || error.status === 501 || error.status === 503) {
      return { state: "unavailable", code: error.code || "CORE_CAPABILITY_UNAVAILABLE", message: error.message };
    }
    return { state: "error", code: error.code || "CORE_REQUEST_FAILED", message: error.message };
  }
  return {
    state: "error",
    code: "CORE_REQUEST_FAILED",
    message: error instanceof Error ? error.message : "Core did not return this report data.",
  };
}

async function readCore<T>(read: () => Promise<T>): Promise<CoreRead<T>> {
  try {
    return { state: "available", data: await read() };
  } catch (error) {
    return readCoreError(error) as Exclude<CoreRead<T>, { state: "available" }>;
  }
}

function positiveInt(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function parseQueryState(url: URL): ReportQueryState {
  const pageSizeValue = positiveInt(url.searchParams.get("pageSize"), 25, 100);
  const pageSize = allowedPageSizes.includes(pageSizeValue as (typeof allowedPageSizes)[number]) ? pageSizeValue : 25;
  const direction = url.searchParams.get("direction") === "desc" ? "desc" : "asc";
  return {
    model: (url.searchParams.get("model") ?? "").slice(0, 120),
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 128),
    filterField: (url.searchParams.get("filterField") ?? "").slice(0, 120),
    filterOperator: (url.searchParams.get("filterOperator") ?? "").slice(0, 40),
    filterValue: (url.searchParams.get("filterValue") ?? "").slice(0, 500),
    sort: (url.searchParams.get("sort") ?? "").slice(0, 120),
    direction,
    page: Math.max(1, positiveInt(url.searchParams.get("page"), 1, 10_000)),
    pageSize,
  };
}

function buildAst(query: ReportQueryState, model: QueryModelMetadata): QueryAstV1 {
  const fields = model.fields.map((field) => field.path);
  const defaultOrder = model.defaultOrder[0] ?? { field: fields[0] ?? "", direction: "asc" as const };
  const sortField = model.fields.some((field) => field.path === query.sort && field.capabilities.sort)
    ? query.sort
    : defaultOrder.field;
  const where: QueryFilterNode[] = [];

  if (query.q) where.push({ type: "text", value: query.q });

  const filterField = model.fields.find((field) => field.path === query.filterField && field.capabilities.filter);
  if (filterField && filterField.operators.includes(query.filterOperator)) {
    const operator = query.filterOperator;
    const condition: QueryFilterNode = { type: "condition", field: filterField.path, operator };
    if (!valueLessOperators.has(operator)) {
      condition.value = listOperators.has(operator)
        ? query.filterValue.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 64)
        : query.filterValue;
    }
    if (valueLessOperators.has(operator) || query.filterValue.trim()) where.push(condition);
  }

  return {
    version: 1,
    model: model.technicalName,
    fields,
    ...(where.length === 1 ? { where: where[0] } : where.length > 1 ? { where: { type: "and", children: where } } : {}),
    orderBy: sortField ? [{ field: sortField, direction: query.direction }] : undefined,
    pagination: { limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  };
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function pageHref(query: ReportQueryState, page: number): string {
  const params = new URLSearchParams();
  if (query.model) params.set("model", query.model);
  if (query.q) params.set("q", query.q);
  if (query.filterField) params.set("filterField", query.filterField);
  if (query.filterOperator) params.set("filterOperator", query.filterOperator);
  if (query.filterValue) params.set("filterValue", query.filterValue);
  if (query.sort) params.set("sort", query.sort);
  params.set("direction", query.direction);
  params.set("page", String(page));
  params.set("pageSize", String(query.pageSize));
  return `/reports?${params.toString()}`;
}

function idempotencyKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hub-export-${(hash >>> 0).toString(16)}`;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<ReportsLoaderData> {
  const hub = await requireHubAccess(request, "/reports");
  const query = parseQueryState(new URL(request.url));
  if (!isAccessAllowed(hub.access)) {
    return { hub, models: { state: "denied", code: hub.access.reason, message: "Core denied access to Query Platform." }, selectedModel: null, query, ast: null, result: null };
  }
  if (!hub.access.permissions.includes("store.read")) {
    return { hub, models: { state: "denied", code: "PERMISSION_REQUIRED", message: "Your Hub role cannot read report data." }, selectedModel: null, query, ast: null, result: null };
  }

  const api = createHubApiClient(request);
  const models = await readCore(() => api.request<QueryModelsResponse>("/api/v1/query/models"));
  if (models.state !== "available") return { hub, models, selectedModel: null, query, ast: null, result: null };

  const selectedModel = models.data.models.find((model) => model.technicalName === query.model) ?? models.data.models[0] ?? null;
  if (!selectedModel) return { hub, models, selectedModel: null, query, ast: null, result: null };

  const effectiveQuery = { ...query, model: selectedModel.technicalName };
  const ast = buildAst(effectiveQuery, selectedModel);
  const result = await readCore(() => api.requestJson<QueryExecutionResponse, { query: QueryAstV1 }>("/api/v1/query/execute", { method: "POST", body: { query: ast } }));
  return { hub, models, selectedModel, query: effectiveQuery, ast, result };
}

export async function action({ request }: ActionFunctionArgs): Promise<ReportActionData> {
  const form = await request.formData();
  if (form.get("intent") !== "export") return { state: "error", code: "ACTION_NOT_SUPPORTED", message: "This report action is not supported." };
  const rawQuery = String(form.get("query") ?? "");
  let ast: QueryAstV1;
  try {
    const parsed: unknown = JSON.parse(rawQuery);
    if (!parsed || typeof parsed !== "object" || !("model" in parsed) || !("fields" in parsed)) throw new Error("invalid query");
    ast = parsed as QueryAstV1;
  } catch {
    return { state: "error", code: "QUERY_PAYLOAD_INVALID", message: "The report query could not be prepared for export." };
  }

  try {
    await createHubApiClient(request).requestJson("/api/v1/query/exports", {
      method: "POST",
      headers: requestCsrfHeaders(request),
      idempotencyKey: idempotencyKey(rawQuery),
      body: { query: ast, selectedFields: ast.fields, format: "CSV" },
    });
    return { state: "success", code: "EXPORT_ACCEPTED", message: "Core accepted the export job." };
  } catch (error) {
    const failure = readCoreError(error);
    return { state: failure.state, code: failure.code, message: failure.message };
  }
}

function capabilityFromRead(read: CoreRead<unknown>, fallbackTitle: string) {
  if (read.state === "available") return { state: "empty" as const, title: fallbackTitle, description: "Core returned no report data.", code: "CORE_EMPTY_RESPONSE" };
  if (read.state === "denied") return { state: "denied" as const, title: fallbackTitle, description: read.message, code: read.code };
  if (read.state === "error") return { state: "error" as const, title: fallbackTitle, description: read.message, code: read.code };
  return { state: "unavailable" as const, title: fallbackTitle, description: read.message, code: read.code };
}

export default function ReportsRoute() {
  const data = useLoaderData() as ReportsLoaderData;
  const actionData = useActionData() as ReportActionData | undefined;
  const result = data.result;
  const filterField = data.selectedModel?.fields.find((field) => field.path === data.query.filterField);
  const exportAction = actionData ? <p className={`aevo-platform-action-result ${actionData.state === "success" ? "is-success" : "is-error"}`} role="status">{actionData.message} <code>{actionData.code}</code></p> : null;

  return (
    <PlatformPage eyebrow="Query Platform" title="Reports" description="Build bounded, tenant-safe reports from models published by Core. Query state stays in the URL; authorization and entitlements stay on the server.">
      {data.models.state !== "available" ? <CapabilityNotice {...capabilityFromRead(data.models, "Report metadata unavailable")} /> : data.selectedModel && data.ast ? (
        <>
          <section className="aevo-platform-section" aria-labelledby="report-query-heading">
            <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Report workspace</span><h2 id="report-query-heading">Model and query</h2><p>Fields and operators come from Core metadata. The browser never supplies tenant scope or SQL.</p></div><StatusBadge tone="success">Core connected</StatusBadge></div>
            <Form method="get" className="aevo-platform-query-form" aria-label="Report query controls">
              <div className="aevo-platform-query-grid">
                <label><span>Report model</span><select name="model" defaultValue={data.selectedModel.technicalName}>{data.models.data.models.map((model) => <option key={model.technicalName} value={model.technicalName}>{model.label}</option>)}</select></label>
                <label><span>Search</span><input type="search" name="q" defaultValue={data.query.q} placeholder="Search report records" /></label>
                <label><span>Rows per page</span><select name="pageSize" defaultValue={String(data.query.pageSize)}>{allowedPageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
                <label><span>Sort direction</span><select name="direction" defaultValue={data.query.direction}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
              </div>
              <details className="aevo-platform-advanced-filters" open={Boolean(data.query.filterField)}>
                <summary>Filters and sorting</summary>
                <div className="aevo-platform-query-grid">
                  <label><span>Filter field</span><select name="filterField" defaultValue={data.query.filterField}><option value="">No field filter</option>{data.selectedModel.fields.filter((field) => field.capabilities.filter).map((field) => <option key={field.path} value={field.path}>{field.label}</option>)}</select></label>
                  <label><span>Operator</span><select name="filterOperator" defaultValue={data.query.filterOperator}><option value="">Choose operator</option>{filterField?.operators.map((operator) => <option key={operator} value={operator}>{operator.replaceAll("_", " ")}</option>)}</select></label>
                  <label><span>Value</span><input name="filterValue" defaultValue={data.query.filterValue} placeholder={listOperators.has(data.query.filterOperator) ? "Comma-separated values" : "Filter value"} disabled={valueLessOperators.has(data.query.filterOperator)} /></label>
                  <label><span>Sort field</span><select name="sort" defaultValue={data.query.sort}><option value="">Core default</option>{data.selectedModel.fields.filter((field) => field.capabilities.sort).map((field) => <option key={field.path} value={field.path}>{field.label}</option>)}</select></label>
                </div>
              </details>
              <input type="hidden" name="page" value="1" />
              <p className="aevo-platform-inline-note">Tenant scope: {data.selectedModel.tenantScope}. The result limit is capped by the Core entitlement and the server maximum.</p>
              <div className="aevo-platform-list-controls__actions"><Button type="submit" variant="primary">Run report</Button><Link className="aevo-button aevo-button--ghost" to="/reports">Reset</Link></div>
            </Form>
          </section>

          <section className="aevo-platform-section" aria-labelledby="report-result-heading">
            <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Report output</span><h2 id="report-result-heading">{data.selectedModel.label}</h2><p>{result?.state === "available" ? `${result.data.rows.length} rows returned from Core.` : "Core will return only rows in the authorized organization and store scope."}</p></div></div>
            {result?.state === "available" ? (
              <>
                <div className="aevo-platform-table-wrap"><table className="aevo-platform-table"><caption>Bounded page {Math.floor(result.data.page.offset / result.data.page.limit) + 1}; Query AST v{result.data.queryVersion}</caption><thead><tr>{result.data.columns.map((column) => <th key={column.path} scope="col">{column.label}</th>)}</tr></thead><tbody>{result.data.rows.length === 0 ? <tr><td colSpan={Math.max(1, result.data.columns.length)}>No rows match this query.</td></tr> : result.data.rows.map((row, index) => <tr key={`${result.data.page.offset}-${index}`}>{result.data.columns.map((column) => <td key={column.path}>{displayValue(row[column.path])}</td>)}</tr>)}</tbody></table></div>
                <nav className="aevo-platform-pagination" aria-label="Report pages"><span>Showing offset {result.data.page.offset}</span>{data.query.page > 1 ? <Link className="aevo-button aevo-button--secondary" to={pageHref(data.query, data.query.page - 1)}>Previous</Link> : <span className="aevo-button aevo-button--secondary" aria-disabled="true">Previous</span>}{result.data.page.hasMore ? <Link className="aevo-button aevo-button--secondary" to={pageHref(data.query, data.query.page + 1)}>Next</Link> : null}</nav>
              </>
            ) : result ? <CapabilityNotice {...capabilityFromRead(result, "Report results unavailable")} /> : <CapabilityNotice state="empty" title="No report model selected" description="Core has not published a readable report model for this organization." />}
          </section>

          <section className="aevo-platform-section" aria-labelledby="report-export-heading">
            <div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Generic export</span><h2 id="report-export-heading">Export the authorized result</h2><p>Exports go through Core with CSRF and an idempotency key. A private worker must be deployed before a file can be generated.</p></div><StatusBadge tone="warning">Worker gate</StatusBadge></div>
            {exportAction}
            <Form method="post" className="aevo-platform-list-controls"><input type="hidden" name="intent" value="export" /><input type="hidden" name="query" value={JSON.stringify(data.ast)} /><div className="aevo-platform-list-controls__actions"><Button type="submit" variant="secondary">Request CSV export</Button><span className="aevo-platform-inline-note">If Core returns `EXPORT_WORKER_NOT_CONFIGURED`, no fake job or download link is shown.</span></div></Form>
          </section>
        </>
      ) : (
        <section className="aevo-platform-section"><CapabilityNotice state="empty" title="No readable report models" description="Core returned no active Query Platform model for this organization." /></section>
      )}
      <section className="aevo-platform-section" aria-labelledby="report-import-heading"><div className="aevo-platform-section__heading"><div><span className="aevo-eyebrow">Generic import</span><h2 id="report-import-heading">Import data</h2><p>Import requires private upload storage, write permissions, validation, and a trusted worker.</p></div></div><CapabilityNotice state="unavailable" title="Import worker is not enabled" description="Aevo Hub will not upload or persist a file until Core exposes the scoped import job contract." code="IMPORT_WORKER_NOT_CONFIGURED" action={<Link className="aevo-button aevo-button--ghost" to="/data">Review data operations</Link>} /></section>
    </PlatformPage>
  );
}
