import type {
  Permission,
  QueryFieldCapabilities,
  QueryFieldMetadata,
  QueryJobStatus,
  QueryAggregate,
  QueryGroupResult,
  QueryModelMetadata,
  QueryModelViewMetadata,
  QueryRelationMetadata,
  QueryNode,
  QueryOperator,
  QueryOrderBy,
  QueryScopeType,
  QuerySearchDefinitionMetadata,
  QuerySpecV1,
  QueryHistoryRecord,
  ExportTemplateRecord,
  QueryImportErrorRecord,
  QueryImportMappingRecord,
  SavedQueryRecord,
  SavedQueryScope,
  SessionPrincipal
} from "@aevo/contracts";
import { queryFieldTypes, queryOperators, savedQueryScopes } from "@aevo/contracts";
import { compileQuery, validateImportRows, validateQuerySpec, type ImportMapping, type ImportSourceRow, type QueryPlan } from "@aevo/query";
import { zipSync, strToU8 } from "fflate";
import { canAccessStore, listAuthorizedStores, resolvePrincipal } from "./repository";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";
import { writeAuditLog } from "./members";

type Row = Record<string, unknown>;

const QUERY_METADATA_CACHE_TTL_MS = 30_000;
const queryMetadataCache = new WeakMap<Database, { expiresAt: number; models: QueryModelMetadata[] }>();
const QUERY_JOB_MAX_ATTEMPTS = 3;
const QUERY_JOB_STALE_AFTER_MS = 15 * 60 * 1000;

export class QueryPlatformError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "QueryPlatformError";
    this.status = status;
    this.code = code;
  }
}

function throwIfError(error: { message: string; code?: string } | null, operation: string): void {
  if (error) throwDatabaseError(error, `query platform ${operation}`);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Row).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value === undefined ? null : value;
}

async function requestFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonicalize(value))));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertIdempotencyMatch(existing: Row, fingerprint: string, code: string): void {
  if (typeof existing.request_fingerprint === "string" && existing.request_fingerprint && existing.request_fingerprint !== fingerprint) {
    throw new QueryPlatformError(409, code, "This idempotency key was already used for a different request");
  }
}

function mapOrder(value: unknown): QueryOrderBy[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.field !== "string" || (candidate.direction !== "asc" && candidate.direction !== "desc")) return [];
    return [{ field: candidate.field, direction: candidate.direction }];
  });
}

function mapCapabilities(value: unknown): QueryFieldCapabilities {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    search: candidate.search === true,
    filter: candidate.filter === true,
    sort: candidate.sort === true,
    group: candidate.group === true,
    export: candidate.export === true,
    import: candidate.import === true,
    ...(candidate.aggregate === true ? { aggregate: true } : {}),
    ...(candidate.bulk_edit === true ? { bulk_edit: true } : {})
  };
}

function mapField(row: Row): QueryFieldMetadata {
  const fieldType = String(row.field_type);
  if (!queryFieldTypes.includes(fieldType as typeof queryFieldTypes[number])) {
    throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported query field type '${fieldType}'`);
  }
  const operators = arrayOfStrings(row.operators).filter((operator): operator is QueryOperator => queryOperators.includes(operator as QueryOperator));
  return {
    path: String(row.path),
    label: String(row.label),
    field_type: fieldType as QueryFieldMetadata["field_type"],
    column_name: String(row.column_name),
    relation_model: typeof row.relation_model === "string" ? row.relation_model : null,
    relation_path: typeof row.relation_path === "string" ? row.relation_path : null,
    capabilities: mapCapabilities(row.capabilities),
    operators,
    read_permission: typeof row.read_permission === "string" ? row.read_permission : null,
    write_permission: typeof row.write_permission === "string" ? row.write_permission : null,
    sequence: Number(row.sequence ?? 0)
  };
}

function mapModel(row: Row, fields: QueryFieldMetadata[]): QueryModelMetadata {
  const scope = String(row.tenant_scope);
  if (!(["ORGANIZATION", "STORE", "PLATFORM"] as readonly string[]).includes(scope)) {
    throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported query scope '${scope}'`);
  }
  const status = String(row.status);
  if (status !== "ACTIVE" && status !== "ARCHIVED") {
    throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported query model status '${status}'`);
  }
  return {
    technical_name: String(row.technical_name),
    table_name: String(row.table_name),
    label: String(row.label),
    module: String(row.module),
    description: String(row.description ?? ""),
    tenant_scope: scope as QueryScopeType,
    read_permission: String(row.read_permission),
    default_search_fields: arrayOfStrings(row.default_search_fields),
    default_order: mapOrder(row.default_order),
    status,
    fields,
    relations: Array.isArray(row.relations) ? row.relations as QueryRelationMetadata[] : [],
    views: Array.isArray(row.views) ? row.views as QueryModelViewMetadata[] : [],
    search_definitions: Array.isArray(row.search_definitions) ? row.search_definitions as QuerySearchDefinitionMetadata[] : []
  };
}

function mapView(row: Row): QueryModelViewMetadata {
  const viewType = String(row.view_type);
  if (viewType !== "LIST" && viewType !== "KANBAN" && viewType !== "PIVOT" && viewType !== "CHART") {
    throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported query view type '${viewType}'`);
  }
  const status = String(row.status);
  if (status !== "ACTIVE" && status !== "ARCHIVED") {
    throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported query view status '${status}'`);
  }
  return {
    view_key: String(row.view_key),
    label: String(row.label),
    view_type: viewType,
    columns: arrayOfStrings(row.columns),
    default_order: mapOrder(row.default_order),
    default_group_by: arrayOfStrings(row.default_group_by),
    status
  };
}

function mapSearchDefinition(row: Row): QuerySearchDefinitionMetadata {
  const status = String(row.status);
  if (status !== "ACTIVE" && status !== "ARCHIVED") {
    throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported query search definition status '${status}'`);
  }
  const overrides: Record<string, QueryOperator[]> = {};
  if (row.operator_overrides && typeof row.operator_overrides === "object" && !Array.isArray(row.operator_overrides)) {
    for (const [field, operators] of Object.entries(row.operator_overrides as Record<string, unknown>)) {
      overrides[field] = arrayOfStrings(operators).filter((operator): operator is QueryOperator => queryOperators.includes(operator as QueryOperator));
    }
  }
  return {
    definition_key: String(row.definition_key),
    label: String(row.label),
    default_search_fields: arrayOfStrings(row.default_search_fields),
    default_order: mapOrder(row.default_order),
    operator_overrides: overrides,
    status,
    is_system: row.is_system === true
  };
}

export async function listQueryModels(database: Database): Promise<QueryModelMetadata[]> {
  const cached = queryMetadataCache.get(database);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const [modelsResult, fieldsResult, relationsResult, viewsResult, searchDefinitionsResult] = await Promise.all([
    database.client
      .from("query_models")
      .select("id,technical_name,table_name,label,module,description,tenant_scope,read_permission,default_search_fields,default_order,status")
      .eq("status", "ACTIVE")
      .order("module", { ascending: true })
      .order("technical_name", { ascending: true }),
    database.client
      .from("query_model_fields")
      .select("model_id,path,label,field_type,column_name,relation_model,relation_path,capabilities,operators,read_permission,write_permission,sequence")
      .order("sequence", { ascending: true })
      .order("path", { ascending: true }),
    database.client
      .from("query_model_relations")
      .select("model_id,path,related_model,related_table,embed_name,source_column,target_column,foreign_key,cardinality")
      .order("path", { ascending: true }),
    database.client
      .from("query_model_views")
      .select("model_id,view_key,label,view_type,columns,default_order,default_group_by,status")
      .eq("status", "ACTIVE")
      .order("view_key", { ascending: true }),
    database.client
      .from("query_search_definitions")
      .select("model_id,definition_key,label,default_search_fields,default_order,operator_overrides,status,is_system")
      .eq("status", "ACTIVE")
      .order("definition_key", { ascending: true })
  ]);
  throwIfError(modelsResult.error, "list models");
  throwIfError(fieldsResult.error, "list model fields");
  throwIfError(relationsResult.error, "list model relations");
  throwIfError(viewsResult.error, "list model views");
  throwIfError(searchDefinitionsResult.error, "list search definitions");
  const fieldRows = (fieldsResult.data ?? []) as Row[];
  const fieldsByModel = new Map<string, QueryFieldMetadata[]>();
  for (const row of fieldRows) {
    const modelId = String(row.model_id);
    const fields = fieldsByModel.get(modelId) ?? [];
    fields.push(mapField(row));
    fieldsByModel.set(modelId, fields);
  }
  const relationsByModel = new Map<string, QueryRelationMetadata[]>();
  for (const row of (relationsResult.data ?? []) as Row[]) {
    const relations = relationsByModel.get(String(row.model_id)) ?? [];
    relations.push({
      path: String(row.path),
      related_model: String(row.related_model),
      related_table: String(row.related_table),
      embed_name: String(row.embed_name),
      source_column: String(row.source_column),
      target_column: String(row.target_column),
      foreign_key: typeof row.foreign_key === "string" ? row.foreign_key : null,
      cardinality: row.cardinality === "one_to_many" || row.cardinality === "one_to_one" ? row.cardinality : "many_to_one"
    });
    relationsByModel.set(String(row.model_id), relations);
  }
  const viewsByModel = new Map<string, QueryModelViewMetadata[]>();
  for (const row of (viewsResult.data ?? []) as Row[]) {
    const views = viewsByModel.get(String(row.model_id)) ?? [];
    views.push(mapView(row));
    viewsByModel.set(String(row.model_id), views);
  }
  const searchDefinitionsByModel = new Map<string, QuerySearchDefinitionMetadata[]>();
  for (const row of (searchDefinitionsResult.data ?? []) as Row[]) {
    const definitions = searchDefinitionsByModel.get(String(row.model_id)) ?? [];
    definitions.push(mapSearchDefinition(row));
    searchDefinitionsByModel.set(String(row.model_id), definitions);
  }
  const models = ((modelsResult.data ?? []) as Row[]).map((row) => mapModel({
    ...row,
    relations: relationsByModel.get(String(row.id)) ?? [],
    views: viewsByModel.get(String(row.id)) ?? [],
    search_definitions: searchDefinitionsByModel.get(String(row.id)) ?? []
  }, fieldsByModel.get(String(row.id)) ?? []));
  queryMetadataCache.set(database, { expiresAt: Date.now() + QUERY_METADATA_CACHE_TTL_MS, models });
  return models;
}

export async function getQueryModel(database: Database, technicalName: string): Promise<QueryModelMetadata> {
  const model = (await listQueryModels(database)).find((candidate) => candidate.technical_name === technicalName);
  if (!model) throw new QueryPlatformError(404, "QUERY_MODEL_NOT_FOUND", `Query model '${technicalName}' was not found`);
  return model;
}

function hasPermission(principal: SessionPrincipal, permission: string): boolean {
  return principal.permissions.includes(permission as Permission);
}

function assertModelReadPermission(principal: SessionPrincipal, model: QueryModelMetadata): void {
  if (!hasPermission(principal, model.read_permission)) {
    throw new QueryPlatformError(403, "QUERY_PERMISSION_REQUIRED", `Permission '${model.read_permission}' is required to read '${model.technical_name}'`);
  }
}

function collectQueryFieldPaths(node: QueryNode | null | undefined, model: QueryModelMetadata, paths: Set<string>): void {
  if (!node) return;
  if (node.type === "condition") {
    paths.add(node.field);
    return;
  }
  if (node.type === "text") {
    for (const field of model.default_search_fields) paths.add(field);
    return;
  }
  if (node.type === "not") {
    collectQueryFieldPaths(node.child, model, paths);
    return;
  }
  for (const child of node.children) collectQueryFieldPaths(child, model, paths);
}

function assertQueryFieldPermissions(principal: SessionPrincipal, model: QueryModelMetadata, query: QuerySpecV1): void {
  const paths = new Set<string>([
    ...(query.fields ?? []),
    ...(query.order_by ?? []).map((item) => item.field),
    ...(query.group_by ?? []),
    ...(query.aggregates ?? []).flatMap((aggregate) => aggregate.field ? [aggregate.field] : [])
  ]);
  collectQueryFieldPaths(query.where, model, paths);
  for (const path of paths) {
    const field = model.fields.find((candidate) => candidate.path === path);
    if (field?.read_permission && !hasPermission(principal, field.read_permission)) {
      throw new QueryPlatformError(403, "QUERY_FIELD_PERMISSION_REQUIRED", `Permission '${field.read_permission}' is required to read '${path}'`);
    }
  }
}

function assertImportFieldPermissions(principal: SessionPrincipal, model: QueryModelMetadata, mappings: ImportMapping[]): void {
  for (const mapping of mappings) {
    const field = model.fields.find((candidate) => candidate.path === mapping.field);
    if (field?.write_permission && !hasPermission(principal, field.write_permission)) {
      throw new QueryPlatformError(403, "QUERY_FIELD_WRITE_PERMISSION_REQUIRED", `Permission '${field.write_permission}' is required to import '${mapping.field}'`);
    }
  }
}

async function resolveAllowedStoreIds(database: Database, principal: SessionPrincipal, requestedStoreId?: string): Promise<string[] | null> {
  if (requestedStoreId) {
    if (!await canAccessStore(database, principal, requestedStoreId)) throw new QueryPlatformError(403, "STORE_SCOPE_FORBIDDEN", "The requested store is outside the current membership scope");
    return [requestedStoreId];
  }
  if (principal.role === "OWNER" || principal.role === "ADMIN" || principal.role === "ORGANIZATION_MANAGER") return null;
  return (await listAuthorizedStores(database, principal)).map((store) => store.id);
}

async function resolveQueryTimezone(database: Database, principal: SessionPrincipal, requestedStoreId?: string): Promise<string> {
  if (requestedStoreId) {
    const storeResult = await database.client
      .from("stores")
      .select("timezone")
      .eq("id", requestedStoreId)
      .eq("organization_id", principal.organizationId)
      .maybeSingle();
    throwIfError(storeResult.error, "resolve query store timezone");
    const storeTimezone = storeResult.data && typeof (storeResult.data as Row).timezone === "string"
      ? String((storeResult.data as Row).timezone)
      : null;
    if (storeTimezone) return storeTimezone;
  }
  const organizationResult = await database.client
    .from("organizations")
    .select("timezone")
    .eq("id", principal.organizationId)
    .maybeSingle();
  throwIfError(organizationResult.error, "resolve query organization timezone");
  const organizationTimezone = organizationResult.data && typeof (organizationResult.data as Row).timezone === "string"
    ? String((organizationResult.data as Row).timezone)
    : null;
  return organizationTimezone || "UTC";
}

function selectColumns(plan: QueryPlan): string {
  if (plan.select_columns.length === 0) throw new QueryPlatformError(400, "QUERY_FIELDS_REQUIRED", "At least one readable output field is required");
  return plan.select_columns.join(",");
}

export interface QueryExecutionResult {
  model: string;
  query: QuerySpecV1;
  rows: Row[];
  total: number;
  groups: QueryGroupResult[];
  aggregates: Record<string, number | null>;
}

function nestedValue(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => nestedValue(item, segments)).filter((item) => item !== undefined && item !== null);
  if (!value || typeof value !== "object") return undefined;
  return nestedValue((value as Row)[segments[0]], segments.slice(1));
}

function queryFieldValue(row: Row, model: QueryModelMetadata, path: string): unknown {
  const field = model.fields.find((candidate) => candidate.path === path);
  if (!field) return undefined;
  if (!field.relation_path) return row[field.column_name];
  const relation = (model.relations ?? []).find((candidate) => candidate.path === field.relation_path);
  if (!relation) return undefined;
  return nestedValue(row, [relation.embed_name, field.column_name]);
}

function displayGroupValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayGroupValue).join(", ");
  if (value === null || value === undefined || value === "") return "(empty)";
  return String(value);
}

function numericValues(rows: Row[], model: QueryModelMetadata, field: string): number[] {
  return rows.flatMap((row) => {
    const value = queryFieldValue(row, model, field);
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) => {
      const numberValue = typeof item === "number" ? item : Number(item);
      return Number.isFinite(numberValue) ? [numberValue] : [];
    });
  });
}

function calculateAggregate(rows: Row[], model: QueryModelMetadata, aggregate: QueryAggregate): number | null {
  if (aggregate.function === "count") return aggregate.field ? rows.filter((row) => queryFieldValue(row, model, aggregate.field as string) !== null && queryFieldValue(row, model, aggregate.field as string) !== undefined).length : rows.length;
  const values = numericValues(rows, model, aggregate.field as string);
  if (values.length === 0) return null;
  switch (aggregate.function) {
    case "sum": return values.reduce((total, value) => total + value, 0);
    case "avg": return values.reduce((total, value) => total + value, 0) / values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
  }
}

function calculateAggregates(rows: Row[], model: QueryModelMetadata, aggregates: QueryAggregate[]): Record<string, number | null> {
  return Object.fromEntries(aggregates.map((aggregate) => [aggregate.alias as string, calculateAggregate(rows, model, aggregate)]));
}

function buildGroups(rows: Row[], model: QueryModelMetadata, groupBy: string[], aggregates: QueryAggregate[]): QueryGroupResult[] {
  if (groupBy.length === 0) return [];
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = groupBy.map((field) => displayGroupValue(queryFieldValue(row, model, field))).join(" / ");
    const members = groups.get(key) ?? [];
    members.push(row);
    groups.set(key, members);
  }
  return [...groups.entries()].map(([key, members]) => ({
    key,
    count: members.length,
    ...(aggregates.length > 0 ? { aggregates: calculateAggregates(members, model, aggregates) } : {})
  }));
}

const MAX_ANALYSIS_ROWS = 10_000;

async function fetchQueryRows(
  database: Database,
  principal: SessionPrincipal,
  model: QueryModelMetadata,
  plan: QueryPlan,
  allowedStoreIds: string[] | null,
  requestedStoreId?: string
): Promise<{ rows: Row[]; total: number }> {
  let query = database.client
    .from(plan.table_name)
    .select(selectColumns(plan), { count: "exact" })
    .eq("organization_id", principal.organizationId);

  const hasStoreColumn = model.fields.some((field) => field.column_name === "store_id");
  if (requestedStoreId && model.table_name === "stores") query = query.eq("id", requestedStoreId);
  if (hasStoreColumn && allowedStoreIds) {
    if (allowedStoreIds.length === 0) return { rows: [], total: 0 };
    query = query.in("store_id", allowedStoreIds);
  }
  if (plan.where_expression && !plan.where_foreign_table) {
    query = query.or(plan.where_expression);
  }
  if (plan.where_foreign_expression && plan.where_foreign_table) {
    const foreignExpression = plan.where_foreign_expression.replaceAll(`${plan.where_foreign_table}.`, "");
    query = query.or(foreignExpression, { foreignTable: plan.where_foreign_table });
  } else if (plan.where_expression && plan.where_foreign_table) {
    const foreignExpression = plan.where_expression.replaceAll(`${plan.where_foreign_table}.`, "");
    query = query.or(foreignExpression, { foreignTable: plan.where_foreign_table });
  }
  for (const order of plan.order_by ?? []) query = query.order(order.field, { ascending: order.direction === "asc" });
  query = query.range(plan.offset, plan.offset + plan.limit - 1);

  const result = await query;
  throwIfError(result.error, "execute query");
  const rows = (result.data ?? []) as unknown as Row[];
  return { rows, total: result.count ?? rows.length };
}

async function recordQueryHistory(
  database: Database,
  principal: SessionPrincipal,
  storeId: string | undefined,
  query: QuerySpecV1,
  resultCount: number,
  durationMs: number
): Promise<void> {
  const result = await database.client.from("query_history").insert({
    organization_id: principal.organizationId,
    store_id: storeId ?? null,
    user_id: principal.userId,
    model: query.model,
    query_definition: query,
    result_count: resultCount,
    duration_ms: durationMs
  });
  if (result.error) {
    console.warn(`[QueryPlatform] query history was not recorded: ${result.error.message}`);
  }
}

function mapQueryHistory(row: Row): QueryHistoryRecord {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    store_id: typeof row.store_id === "string" ? row.store_id : null,
    user_id: String(row.user_id),
    model: String(row.model),
    query: row.query_definition as QuerySpecV1,
    result_count: Number(row.result_count ?? 0),
    duration_ms: typeof row.duration_ms === "number" ? row.duration_ms : null,
    created_at: String(row.created_at)
  };
}

export async function executeQuery(
  database: Database,
  principal: SessionPrincipal,
  input: unknown,
  requestedStoreId?: string
): Promise<QueryExecutionResult> {
  const startedAt = performance.now();
  if (!input || typeof input !== "object") throw new QueryPlatformError(400, "QUERY_INVALID", "Query must be an object");
  const modelName = String((input as Record<string, unknown>).model ?? "");
  const model = await getQueryModel(database, modelName);
  assertModelReadPermission(principal, model);
  if (model.tenant_scope === "PLATFORM") throw new QueryPlatformError(403, "QUERY_PLATFORM_SCOPE", "Platform models are not available to tenant queries");

  const normalized = validateQuerySpec(input, model);
  assertQueryFieldPermissions(principal, model, normalized);
  const timezone = await resolveQueryTimezone(database, principal, requestedStoreId);
  const compileOptions = { timezone };
  const plan = compileQuery(normalized, model, compileOptions);
  const allowedStoreIds = await resolveAllowedStoreIds(database, principal, requestedStoreId);
  const result = await fetchQueryRows(database, principal, model, plan, allowedStoreIds, requestedStoreId);
  const rows = result.rows;
  const total = result.total;
  if ((normalized.group_by?.length ?? 0) > 0 || (normalized.aggregates?.length ?? 0) > 0) {
    if (total > MAX_ANALYSIS_ROWS) {
      throw new QueryPlatformError(422, "QUERY_ANALYSIS_LIMIT", `Grouping and aggregates are limited to ${MAX_ANALYSIS_ROWS.toLocaleString()} matching rows`);
    }
    const analysisFields = [...new Set([
      ...(normalized.fields ?? []).slice(0, 1),
      ...(normalized.group_by ?? []),
      ...(normalized.aggregates ?? []).flatMap((aggregate) => aggregate.field ? [aggregate.field] : [])
    ])];
    const analysisQuery = {
      ...normalized,
      fields: analysisFields,
      order_by: [],
      pagination: { limit: Math.max(total, 1), offset: 0 }
    } satisfies QuerySpecV1;
    const analysisPlan = compileQuery(analysisQuery, model, compileOptions);
    const analysisResult = await fetchQueryRows(database, principal, model, analysisPlan, allowedStoreIds, requestedStoreId);
    const groups = buildGroups(analysisResult.rows, model, normalized.group_by ?? [], normalized.aggregates ?? []);
    const aggregates = calculateAggregates(analysisResult.rows, model, normalized.aggregates ?? []);
    const output = { model: model.technical_name, query: normalized, rows, total, groups, aggregates };
    await recordQueryHistory(database, principal, requestedStoreId, normalized, total, Math.round(performance.now() - startedAt));
    return output;
  }
  const output = {
    model: model.technical_name,
    query: normalized,
    rows,
    total,
    groups: [],
    aggregates: {}
  };
  await recordQueryHistory(database, principal, requestedStoreId, normalized, output.total, Math.round(performance.now() - startedAt));
  return output;
}

export async function listQueryHistory(
  database: Database,
  principal: SessionPrincipal,
  model?: string,
  requestedLimit = 50
): Promise<QueryHistoryRecord[]> {
  if (!hasPermission(principal, "query.read")) throw new QueryPlatformError(403, "QUERY_PERMISSION_REQUIRED", "Permission 'query.read' is required");
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 50, 1), 100);
  let query = database.client
    .from("query_history")
    .select("id,organization_id,store_id,user_id,model,query_definition,result_count,duration_ms,created_at")
    .eq("organization_id", principal.organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (model) query = query.eq("model", model);
  const result = await query;
  throwIfError(result.error, "list query history");
  const allowedStoreIds = await resolveAllowedStoreIds(database, principal);
  return ((result.data ?? []) as unknown as Row[])
    .map(mapQueryHistory)
    .filter((history) => {
      if (!hasPermission(principal, "query.manage") && history.user_id !== principal.userId) return false;
      return !history.store_id || allowedStoreIds === null || allowedStoreIds.includes(history.store_id);
    });
}

function mapSavedQuery(row: Row): SavedQueryRecord {
  const scope = String(row.scope);
  if (!savedQueryScopes.includes(scope as SavedQueryScope)) throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported saved query scope '${scope}'`);
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    store_id: typeof row.store_id === "string" ? row.store_id : null,
    owner_user_id: String(row.owner_user_id),
    name: String(row.name),
    model: String(row.model),
    scope: scope as SavedQueryScope,
    query: row.query_definition as QuerySpecV1,
    status: row.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export interface CreateSavedQueryInput {
  name: string;
  scope: SavedQueryScope;
  storeId?: string;
  query: unknown;
}

async function validateSavedQueryInput(database: Database, principal: SessionPrincipal, input: CreateSavedQueryInput): Promise<{ model: QueryModelMetadata; query: QuerySpecV1 }> {
  const modelName = input.query && typeof input.query === "object" ? String((input.query as Record<string, unknown>).model ?? "") : "";
  const model = await getQueryModel(database, modelName);
  assertModelReadPermission(principal, model);
  const query = validateQuerySpec(input.query, model);
  assertQueryFieldPermissions(principal, model, query);
  if (input.scope === "SYSTEM") throw new QueryPlatformError(403, "QUERY_SYSTEM_SCOPE_FORBIDDEN", "System saved queries are managed by the platform");
  if (input.scope !== "PRIVATE" && !hasPermission(principal, "query.manage")) throw new QueryPlatformError(403, "QUERY_MANAGE_REQUIRED", "Sharing a saved query requires query.manage");
  if (input.scope === "STORE") {
    if (!input.storeId) throw new QueryPlatformError(400, "STORE_REQUIRED", "A store is required for a store-scoped saved query");
    if (!await canAccessStore(database, principal, input.storeId)) throw new QueryPlatformError(403, "STORE_SCOPE_FORBIDDEN", "The requested store is outside the current membership scope");
  }
  return { model, query };
}

export async function createSavedQuery(database: Database, principal: SessionPrincipal, input: CreateSavedQueryInput): Promise<SavedQueryRecord> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 160) throw new QueryPlatformError(400, "QUERY_NAME_INVALID", "Saved query name must be between 1 and 160 characters");
  const { model, query } = await validateSavedQueryInput(database, principal, input);
  const result = await database.client
    .from("query_saved_queries")
    .insert({
      organization_id: principal.organizationId,
      store_id: input.storeId ?? null,
      owner_user_id: principal.userId,
      name,
      model: model.technical_name,
      scope: input.scope,
      query_definition: query
    })
    .select("id,organization_id,store_id,owner_user_id,name,model,scope,query_definition,status,created_at,updated_at")
    .single();
  if (result.error || !result.data) {
    if (result.error?.code === "23505") throw new QueryPlatformError(409, "QUERY_NAME_EXISTS", "A saved query with this name already exists");
    throwDatabaseError(result.error, "create saved query");
  }
  return mapSavedQuery(result.data as Row);
}

export async function listSavedQueries(database: Database, principal: SessionPrincipal, model?: string): Promise<SavedQueryRecord[]> {
  let query = database.client
    .from("query_saved_queries")
    .select("id,organization_id,store_id,owner_user_id,name,model,scope,query_definition,status,created_at,updated_at")
    .eq("organization_id", principal.organizationId)
    .eq("status", "ACTIVE")
    .order("updated_at", { ascending: false });
  if (model) query = query.eq("model", model);
  const result = await query;
  throwIfError(result.error, "list saved queries");
  const allowedStoreIds = await resolveAllowedStoreIds(database, principal);
  return ((result.data ?? []) as unknown as Row[])
    .map(mapSavedQuery)
    .filter((saved) => {
      if (saved.scope === "PRIVATE") return saved.owner_user_id === principal.userId;
      if (saved.scope === "STORE") return typeof saved.store_id === "string" && (allowedStoreIds === null || allowedStoreIds.includes(saved.store_id));
      return true;
    });
}

export async function archiveSavedQuery(database: Database, principal: SessionPrincipal, id: string): Promise<void> {
  const existing = await database.client
    .from("query_saved_queries")
    .select("id,owner_user_id,organization_id")
    .eq("id", id)
    .eq("organization_id", principal.organizationId)
    .maybeSingle();
  throwIfError(existing.error, "find saved query");
  if (!existing.data) throw new QueryPlatformError(404, "QUERY_NOT_FOUND", "Saved query was not found");
  const row = existing.data as Row;
  if (String(row.owner_user_id) !== principal.userId && !hasPermission(principal, "query.manage")) throw new QueryPlatformError(403, "QUERY_MANAGE_REQUIRED", "You cannot archive this saved query");
  const result = await database.client
    .from("query_saved_queries")
    .update({ status: "ARCHIVED", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", principal.organizationId);
  throwIfError(result.error, "archive saved query");
}

function mapExportTemplate(row: Row): ExportTemplateRecord {
  const scope = String(row.scope);
  if (!savedQueryScopes.includes(scope as SavedQueryScope)) throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported export template scope '${scope}'`);
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    store_id: typeof row.store_id === "string" ? row.store_id : null,
    owner_user_id: String(row.owner_user_id),
    name: String(row.name),
    model: String(row.model),
    scope: scope as SavedQueryScope,
    query: row.query_definition as QuerySpecV1,
    selected_fields: arrayOfStrings(row.selected_fields),
    status: row.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export interface CreateExportTemplateInput {
  name: string;
  scope: SavedQueryScope;
  storeId?: string;
  query: unknown;
  selectedFields?: string[];
}

async function validateExportDefinition(
  database: Database,
  principal: SessionPrincipal,
  queryInput: unknown,
  selectedFields?: string[]
): Promise<{ model: QueryModelMetadata; query: QuerySpecV1; fields: string[] }> {
  const input = queryInput && typeof queryInput === "object" ? queryInput as Record<string, unknown> : {};
  const model = await getQueryModel(database, String(input.model ?? ""));
  assertModelReadPermission(principal, model);
  const query = validateQuerySpec({ ...input, ...(selectedFields ? { fields: selectedFields } : {}) }, model);
  assertQueryFieldPermissions(principal, model, query);
  const fields = query.fields ?? [];
  for (const fieldPath of fields) {
    const field = model.fields.find((candidate) => candidate.path === fieldPath);
    if (!field?.capabilities.export) throw new QueryPlatformError(403, "QUERY_FIELD_EXPORT_FORBIDDEN", `Field '${fieldPath}' cannot be exported`);
  }
  return { model, query, fields };
}

async function validateExportTemplateInput(
  database: Database,
  principal: SessionPrincipal,
  input: CreateExportTemplateInput
): Promise<{ model: QueryModelMetadata; query: QuerySpecV1; fields: string[] }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 160) throw new QueryPlatformError(400, "QUERY_NAME_INVALID", "Export template name must be between 1 and 160 characters");
  if (input.scope === "SYSTEM") throw new QueryPlatformError(403, "QUERY_SYSTEM_SCOPE_FORBIDDEN", "System export templates are managed by the platform");
  if (input.scope !== "PRIVATE" && !hasPermission(principal, "query.manage")) throw new QueryPlatformError(403, "QUERY_MANAGE_REQUIRED", "Sharing an export template requires query.manage");
  if (input.scope === "STORE") {
    if (!input.storeId) throw new QueryPlatformError(400, "STORE_REQUIRED", "A store is required for a store-scoped export template");
    if (!await canAccessStore(database, principal, input.storeId)) throw new QueryPlatformError(403, "STORE_SCOPE_FORBIDDEN", "The requested store is outside the current membership scope");
  }
  return validateExportDefinition(database, principal, input.query, input.selectedFields);
}

export async function createExportTemplate(database: Database, principal: SessionPrincipal, input: CreateExportTemplateInput): Promise<ExportTemplateRecord> {
  const { model, query, fields } = await validateExportTemplateInput(database, principal, input);
  const result = await database.client
    .from("query_export_templates")
    .insert({
      organization_id: principal.organizationId,
      store_id: input.storeId ?? null,
      owner_user_id: principal.userId,
      name: input.name.trim(),
      model: model.technical_name,
      scope: input.scope,
      query_definition: query,
      selected_fields: fields
    })
    .select("id,organization_id,store_id,owner_user_id,name,model,scope,query_definition,selected_fields,status,created_at,updated_at")
    .single();
  if (result.error || !result.data) {
    if (result.error?.code === "23505") throw new QueryPlatformError(409, "QUERY_NAME_EXISTS", "An export template with this name already exists");
    throwDatabaseError(result.error, "create export template");
  }
  return mapExportTemplate(result.data as unknown as Row);
}

export async function listExportTemplates(database: Database, principal: SessionPrincipal, model?: string): Promise<ExportTemplateRecord[]> {
  if (!hasPermission(principal, "query.read")) throw new QueryPlatformError(403, "QUERY_PERMISSION_REQUIRED", "Permission 'query.read' is required");
  let query = database.client
    .from("query_export_templates")
    .select("id,organization_id,store_id,owner_user_id,name,model,scope,query_definition,selected_fields,status,created_at,updated_at")
    .eq("organization_id", principal.organizationId)
    .eq("status", "ACTIVE")
    .order("updated_at", { ascending: false });
  if (model) query = query.eq("model", model);
  const result = await query;
  throwIfError(result.error, "list export templates");
  const allowedStoreIds = await resolveAllowedStoreIds(database, principal);
  return ((result.data ?? []) as unknown as Row[])
    .map(mapExportTemplate)
    .filter((template) => {
      if (template.scope === "PRIVATE") return template.owner_user_id === principal.userId;
      if (template.scope === "STORE") return typeof template.store_id === "string" && (allowedStoreIds === null || allowedStoreIds.includes(template.store_id));
      return true;
    });
}

export async function archiveExportTemplate(database: Database, principal: SessionPrincipal, id: string): Promise<void> {
  const existing = await database.client
    .from("query_export_templates")
    .select("id,owner_user_id,organization_id")
    .eq("id", id)
    .eq("organization_id", principal.organizationId)
    .maybeSingle();
  throwIfError(existing.error, "find export template");
  if (!existing.data) throw new QueryPlatformError(404, "EXPORT_TEMPLATE_NOT_FOUND", "Export template was not found");
  const row = existing.data as Row;
  if (String(row.owner_user_id) !== principal.userId && !hasPermission(principal, "query.manage")) throw new QueryPlatformError(403, "QUERY_MANAGE_REQUIRED", "You cannot archive this export template");
  const result = await database.client
    .from("query_export_templates")
    .update({ status: "ARCHIVED", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", principal.organizationId);
  throwIfError(result.error, "archive export template");
}

export interface ImportJobSummary {
  id: string;
  organization_id: string;
  store_id?: string | null;
  created_by: string;
  model: string;
  status: QueryJobStatus;
  source_file_name: string;
  total_rows: number;
  valid_rows: number;
  failed_rows: number;
  processed_rows: number;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface ImportJobDetails {
  importJob: ImportJobSummary;
  mappings: QueryImportMappingRecord[];
  errors: QueryImportErrorRecord[];
}

function mapImportJob(row: Row): ImportJobSummary {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    store_id: typeof row.store_id === "string" ? row.store_id : null,
    created_by: String(row.created_by),
    model: String(row.model),
    status: queryJobStatus(String(row.status)),
    source_file_name: String(row.source_file_name),
    total_rows: Number(row.total_rows ?? 0),
    valid_rows: Number(row.valid_rows ?? 0),
    failed_rows: Number(row.failed_rows ?? 0),
    processed_rows: Number(row.processed_rows ?? 0),
    error_message: typeof row.error_message === "string" ? row.error_message : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null
  };
}

function importPermission(principal: SessionPrincipal): void {
  if (!hasPermission(principal, "query.import")) throw new QueryPlatformError(403, "QUERY_IMPORT_REQUIRED", "Permission 'query.import' is required");
}

function exportPermission(principal: SessionPrincipal): void {
  if (!hasPermission(principal, "query.export")) throw new QueryPlatformError(403, "QUERY_EXPORT_REQUIRED", "Permission 'query.export' is required");
}

export interface CreateImportJobInput {
  model: string;
  sourceFileName: string;
  sourceContentType?: string;
  idempotencyKey: string;
  columns: string[];
  rows: ImportSourceRow[];
  mappings?: ImportMapping[];
  storeId?: string;
}

export interface CreateImportJobResult {
  importJob: ImportJobSummary;
  created: boolean;
}

async function getImportJobRow(database: Database, principal: SessionPrincipal, id: string): Promise<Row> {
  const result = await database.client
    .from("query_import_jobs")
    .select("id,organization_id,store_id,created_by,model,status,source_file_name,source_content_type,idempotency_key,total_rows,valid_rows,failed_rows,processed_rows,query_definition,source_rows,error_message,attempt_count,locked_at,locked_by,next_attempt_at,processing_started_at,created_at,updated_at,completed_at")
    .eq("id", id)
    .eq("organization_id", principal.organizationId)
    .maybeSingle();
  throwIfError(result.error, "find import job");
  if (!result.data) throw new QueryPlatformError(404, "IMPORT_JOB_NOT_FOUND", "Import job was not found");
  const row = result.data as unknown as Row;
  if (String(row.created_by) !== principal.userId && !hasPermission(principal, "query.import")) throw new QueryPlatformError(403, "QUERY_IMPORT_REQUIRED", "You cannot access this import job");
  return row;
}

export async function createImportJob(database: Database, principal: SessionPrincipal, input: CreateImportJobInput): Promise<CreateImportJobResult> {
  importPermission(principal);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new QueryPlatformError(400, "IMPORT_IDEMPOTENCY_REQUIRED", "An idempotency key is required for import jobs");
  if (!input.sourceFileName.trim() || input.columns.length === 0 || input.rows.length === 0) throw new QueryPlatformError(400, "IMPORT_PAYLOAD_INVALID", "Import requires a file name, columns, and at least one row");
  if (input.rows.length > 10_000) throw new QueryPlatformError(422, "IMPORT_TOO_LARGE", "Import preview is limited to 10,000 rows");
  const fingerprint = await requestFingerprint({
    model: input.model.trim(),
    sourceFileName: input.sourceFileName.trim(),
    sourceContentType: input.sourceContentType ?? "application/json",
    columns: input.columns,
    rows: input.rows,
    mappings: input.mappings ?? [],
    storeId: input.storeId ?? null
  });
  const existing = await database.client
    .from("query_import_jobs")
    .select("id,organization_id,store_id,created_by,model,status,source_file_name,total_rows,valid_rows,failed_rows,processed_rows,error_message,request_fingerprint,created_at,updated_at,completed_at")
    .eq("organization_id", principal.organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  throwIfError(existing.error, "find import idempotency key");
  if (existing.data) {
    assertIdempotencyMatch(existing.data as unknown as Row, fingerprint, "IMPORT_IDEMPOTENCY_REUSED");
    return { importJob: mapImportJob(existing.data as unknown as Row), created: false };
  }

  const model = await getQueryModel(database, input.model);
  assertModelReadPermission(principal, model);
  if (model.tenant_scope === "PLATFORM") throw new QueryPlatformError(403, "QUERY_PLATFORM_SCOPE", "Platform models are not available to tenant imports");
  const allowedStoreIds = await resolveAllowedStoreIds(database, principal, input.storeId);
  if (input.storeId && allowedStoreIds === null) throw new QueryPlatformError(403, "STORE_SCOPE_FORBIDDEN", "The requested store is outside the current membership scope");
  const validation = validateImportRows(model, input.columns, input.rows, input.mappings ?? []);
  assertImportFieldPermissions(principal, model, validation.mappings);
  const failedRowCount = new Set(validation.errors.map((error) => error.row_number)).size;
  const status = validation.valid_rows.length > 0 ? "READY" : "FAILED";
  const jobResult = await database.client
    .from("query_import_jobs")
    .insert({
      organization_id: principal.organizationId,
      store_id: input.storeId ?? null,
      created_by: principal.userId,
      model: model.technical_name,
      status,
      source_file_name: input.sourceFileName.trim(),
      source_content_type: input.sourceContentType ?? "application/json",
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      total_rows: input.rows.length,
      valid_rows: validation.valid_rows.length,
      failed_rows: failedRowCount,
      processed_rows: 0,
      query_definition: { version: 1, model: model.technical_name },
      source_rows: input.rows,
      error_message: status === "FAILED" ? "No valid rows are ready for import" : null
    })
    .select("id,organization_id,store_id,created_by,model,status,source_file_name,total_rows,valid_rows,failed_rows,processed_rows,error_message,request_fingerprint,created_at,updated_at,completed_at")
    .single();
  if (jobResult.error || !jobResult.data) {
    if (jobResult.error?.code === "23505") {
      const retry = await database.client
        .from("query_import_jobs")
        .select("id,organization_id,store_id,created_by,model,status,source_file_name,total_rows,valid_rows,failed_rows,processed_rows,error_message,request_fingerprint,created_at,updated_at,completed_at")
        .eq("organization_id", principal.organizationId)
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (retry.error || !retry.data) throwDatabaseError(retry.error, "read idempotent import job");
      assertIdempotencyMatch(retry.data as unknown as Row, fingerprint, "IMPORT_IDEMPOTENCY_REUSED");
      return { importJob: mapImportJob(retry.data as unknown as Row), created: false };
    }
    throwDatabaseError(jobResult.error, "create import job");
  }
  const jobId = String((jobResult.data as Row).id);

  const columnResult = await database.client
    .from("query_import_columns")
    .insert(input.columns.map((sourceName, columnIndex) => ({
      job_id: jobId,
      column_index: columnIndex,
      source_name: sourceName,
      sample_values: input.rows.slice(0, 5).map((row) => row[sourceName] ?? null)
    })))
    .select("id,source_name");
  throwIfError(columnResult.error, "create import columns");
  const columnIds = new Map(((columnResult.data ?? []) as unknown as Row[]).map((row) => [String(row.source_name), String(row.id)]));
  const mappingRows = validation.mappings.flatMap((mapping) => {
    const sourceColumnId = columnIds.get(mapping.source);
    return sourceColumnId ? [{ job_id: jobId, source_column_id: sourceColumnId, field_path: mapping.field, confidence: 1 }] : [];
  });
  if (mappingRows.length > 0) {
    const mappingsResult = await database.client.from("query_import_mappings").insert(mappingRows);
    throwIfError(mappingsResult.error, "create import mappings");
  }
  if (validation.errors.length > 0) {
    const errorsResult = await database.client.from("query_import_errors").insert(validation.errors.map((error) => ({ job_id: jobId, ...error })));
    throwIfError(errorsResult.error, "create import errors");
  }
  return { importJob: mapImportJob(jobResult.data as unknown as Row), created: true };
}

export async function listImportJobs(database: Database, principal: SessionPrincipal): Promise<ImportJobSummary[]> {
  importPermission(principal);
  const result = await database.client
    .from("query_import_jobs")
    .select("id,organization_id,store_id,created_by,model,status,source_file_name,total_rows,valid_rows,failed_rows,processed_rows,error_message,created_at,updated_at,completed_at")
    .eq("organization_id", principal.organizationId)
    .order("created_at", { ascending: false })
    .limit(100);
  throwIfError(result.error, "list import jobs");
  return ((result.data ?? []) as unknown as Row[]).map(mapImportJob);
}

export async function getImportJob(database: Database, principal: SessionPrincipal, id: string): Promise<ImportJobSummary> {
  return mapImportJob(await getImportJobRow(database, principal, id));
}

export async function getImportJobDetails(database: Database, principal: SessionPrincipal, id: string): Promise<ImportJobDetails> {
  const row = await getImportJobRow(database, principal, id);
  const [columnsResult, mappingsResult, errorsResult] = await Promise.all([
    database.client.from("query_import_columns").select("id,source_name").eq("job_id", id).order("column_index", { ascending: true }),
    database.client.from("query_import_mappings").select("source_column_id,field_path,confidence").eq("job_id", id),
    database.client.from("query_import_errors").select("row_number,field_path,error_code,message,source_data").eq("job_id", id).order("row_number", { ascending: true })
  ]);
  throwIfError(columnsResult.error, "read import detail columns");
  throwIfError(mappingsResult.error, "read import detail mappings");
  throwIfError(errorsResult.error, "read import detail errors");
  const sourceById = new Map(((columnsResult.data ?? []) as unknown as Row[]).map((column) => [String(column.id), String(column.source_name)]));
  const mappings = ((mappingsResult.data ?? []) as unknown as Row[]).flatMap((mapping): QueryImportMappingRecord[] => {
    const source = sourceById.get(String(mapping.source_column_id));
    if (!source || typeof mapping.field_path !== "string") return [];
    return [{ source, field: mapping.field_path, confidence: typeof mapping.confidence === "number" ? mapping.confidence : null }];
  });
  const errors = ((errorsResult.data ?? []) as unknown as Row[]).map((error): QueryImportErrorRecord => ({
    row_number: Number(error.row_number),
    field_path: typeof error.field_path === "string" ? error.field_path : null,
    error_code: String(error.error_code),
    message: String(error.message),
    source_data: error.source_data && typeof error.source_data === "object" ? error.source_data as Record<string, unknown> : {}
  }));
  return { importJob: mapImportJob(row), mappings, errors };
}

export interface UpdateImportMappingsInput {
  mappings: ImportMapping[];
}

function assertImportMappings(model: QueryModelMetadata, columns: string[], mappings: ImportMapping[]): void {
  const knownColumns = new Set(columns);
  const seenSources = new Set<string>();
  const seenFields = new Set<string>();
  for (const mapping of mappings) {
    if (!knownColumns.has(mapping.source)) throw new QueryPlatformError(422, "IMPORT_SOURCE_COLUMN_UNKNOWN", `Source column '${mapping.source}' is not part of the uploaded file`);
    if (seenSources.has(mapping.source)) throw new QueryPlatformError(422, "IMPORT_SOURCE_COLUMN_DUPLICATE", `Source column '${mapping.source}' is mapped more than once`);
    if (seenFields.has(mapping.field)) throw new QueryPlatformError(422, "IMPORT_TARGET_FIELD_DUPLICATE", `Target field '${mapping.field}' is mapped more than once`);
    const field = model.fields.find((candidate) => candidate.path === mapping.field);
    if (!field) throw new QueryPlatformError(422, "IMPORT_TARGET_FIELD_UNKNOWN", `Target field '${mapping.field}' is not registered for '${model.technical_name}'`);
    if (!field.capabilities.import) throw new QueryPlatformError(403, "QUERY_FIELD_IMPORT_FORBIDDEN", `Field '${mapping.field}' cannot be imported`);
    seenSources.add(mapping.source);
    seenFields.add(mapping.field);
  }
}

export async function updateImportMappings(database: Database, principal: SessionPrincipal, id: string, input: UpdateImportMappingsInput): Promise<ImportJobDetails> {
  importPermission(principal);
  const job = await getImportJobRow(database, principal, id);
  if (!["READY", "FAILED", "MAPPING", "VALIDATING"].includes(String(job.status))) {
    throw new QueryPlatformError(409, "IMPORT_MAPPING_LOCKED", "Mappings can only be changed before an import is queued");
  }
  const model = await getQueryModel(database, String(job.model));
  const columnsResult = await database.client.from("query_import_columns").select("id,source_name").eq("job_id", id).order("column_index", { ascending: true });
  throwIfError(columnsResult.error, "read import mapping columns");
  const columns = ((columnsResult.data ?? []) as unknown as Row[]).map((row) => String(row.source_name));
  assertImportMappings(model, columns, input.mappings);
  const sourceRows = Array.isArray(job.source_rows) ? job.source_rows as ImportSourceRow[] : [];
  const validation = validateImportRows(model, columns, sourceRows, input.mappings);
  assertImportFieldPermissions(principal, model, validation.mappings);

  const deleteMappings = await database.client.from("query_import_mappings").delete().eq("job_id", id);
  throwIfError(deleteMappings.error, "replace import mappings");
  const deleteErrors = await database.client.from("query_import_errors").delete().eq("job_id", id);
  throwIfError(deleteErrors.error, "replace import errors");
  const columnIds = new Map(((columnsResult.data ?? []) as unknown as Row[]).map((row) => [String(row.source_name), String(row.id)]));
  const mappingRows = validation.mappings.flatMap((mapping) => {
    const sourceColumnId = columnIds.get(mapping.source);
    return sourceColumnId ? [{ job_id: id, source_column_id: sourceColumnId, field_path: mapping.field, confidence: 1 }] : [];
  });
  if (mappingRows.length > 0) {
    const mappingsResult = await database.client.from("query_import_mappings").insert(mappingRows);
    throwIfError(mappingsResult.error, "write import mappings");
  }
  if (validation.errors.length > 0) {
    const errorsResult = await database.client.from("query_import_errors").insert(validation.errors.map((error) => ({ job_id: id, ...error })));
    throwIfError(errorsResult.error, "write import validation errors");
  }
  const status = validation.valid_rows.length > 0 ? "READY" : "FAILED";
  const updated = await database.client.from("query_import_jobs").update({
    status,
    valid_rows: validation.valid_rows.length,
    failed_rows: new Set(validation.errors.map((error) => error.row_number)).size,
    processed_rows: 0,
    error_message: status === "FAILED" ? "No valid rows are ready for import" : null,
    query_definition: { version: 1, model: model.technical_name, mappings: validation.mappings },
    updated_at: new Date().toISOString()
  }).eq("id", id).eq("organization_id", principal.organizationId);
  throwIfError(updated.error, "update import mapping state");
  return getImportJobDetails(database, principal, id);
}

export async function getImportErrorCsv(database: Database, principal: SessionPrincipal, id: string): Promise<{ fileName: string; content: string }> {
  const details = await getImportJobDetails(database, principal, id);
  const sourceColumns = [...new Set(details.errors.flatMap((error) => Object.keys(error.source_data)))];
  const header = ["row_number", "field_path", "error_code", "message", ...sourceColumns];
  const rows = details.errors.map((error) => [
    error.row_number,
    error.field_path ?? "",
    error.error_code,
    error.message,
    ...sourceColumns.map((column) => error.source_data[column] ?? "")
  ]);
  return {
    fileName: `aevo-import-errors-${details.importJob.id}.csv`,
    content: [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")
  };
}

export async function confirmImportJob(database: Database, principal: SessionPrincipal, id: string): Promise<ImportJobSummary> {
  importPermission(principal);
  const job = await getImportJobRow(database, principal, id);
  if (String(job.status) === "QUEUED" || String(job.status) === "PROCESSING" || String(job.status) === "COMPLETED") return mapImportJob(job);
  if (String(job.status) !== "READY") throw new QueryPlatformError(409, "IMPORT_NOT_READY", "Only a READY import job can be confirmed");
  const model = await getQueryModel(database, String(job.model));
  const conflictColumns: Record<string, string> = {
    "product.product": "organization_id,sku",
    "product.category": "organization_id,code",
    "res.store": "organization_id,code"
  };
  const onConflict = conflictColumns[model.technical_name];
  if (!onConflict) {
    await database.client.from("query_import_jobs").update({ status: "FAILED", error_message: `The '${model.technical_name}' model does not have an import writer yet`, locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).eq("id", id).eq("organization_id", principal.organizationId);
    throw new QueryPlatformError(422, "IMPORT_MODEL_UNSUPPORTED", `The '${model.technical_name}' model does not have an import writer yet`);
  }
  const now = new Date().toISOString();
  const queued = await database.client
    .from("query_import_jobs")
    .update({ status: "QUEUED", next_attempt_at: now, updated_at: now })
    .eq("id", id)
    .eq("organization_id", principal.organizationId)
    .eq("status", "READY")
    .select("id,organization_id,store_id,created_by,model,status,source_file_name,total_rows,valid_rows,failed_rows,processed_rows,error_message,created_at,updated_at,completed_at")
    .maybeSingle();
  throwIfError(queued.error, "queue import job");
  if (queued.data) return mapImportJob(queued.data as unknown as Row);
  return mapImportJob(await getImportJobRow(database, principal, id));
}

async function recordQueryJobAudit(
  database: Database,
  principal: SessionPrincipal,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await writeAuditLog(database, {
      organizationId: principal.organizationId,
      userId: principal.userId,
      action,
      resourceType,
      resourceId,
      metadata
    });
  } catch (error) {
    console.warn(`[QueryPlatform] could not write ${action} audit: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function retryAt(attempt: number): string {
  const delayMs = Math.min(60_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
  return new Date(Date.now() + delayMs).toISOString();
}

function isRetryableJobError(error: unknown): boolean {
  return !(error instanceof QueryPlatformError);
}

/**
 * Process one validated import outside the HTTP request. The worker repeats
 * validation and permission checks because a user's access may have changed
 * after preview/confirmation.
 */
export async function processImportJob(database: Database, principal: SessionPrincipal, id: string): Promise<ImportJobSummary> {
  importPermission(principal);
  const current = await getImportJobRow(database, principal, id);
  if (String(current.status) === "COMPLETED") return mapImportJob(current);
  if (String(current.status) === "CANCELLED") throw new QueryPlatformError(409, "IMPORT_CANCELLED", "The import job was cancelled");
  if (String(current.status) !== "QUEUED") return mapImportJob(current);

  const workerId = `query-import-${crypto.randomUUID()}`;
  const claimed = await database.client
    .from("query_import_jobs")
    .update({
      status: "PROCESSING",
      attempt_count: Number(current.attempt_count ?? 0) + 1,
      locked_at: new Date().toISOString(),
      locked_by: workerId,
      processing_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("organization_id", principal.organizationId)
    .eq("status", "QUEUED")
    .select("id")
    .maybeSingle();
  throwIfError(claimed.error, "claim import job");
  if (!claimed.data) return mapImportJob(await getImportJobRow(database, principal, id));

  try {
    const job = await getImportJobRow(database, principal, id);
    const model = await getQueryModel(database, String(job.model));
    const conflictColumns: Record<string, string> = {
      "product.product": "organization_id,sku",
      "product.category": "organization_id,code",
      "res.store": "organization_id,code",
      "product.variant": "organization_id,code"
    };
    const onConflict = conflictColumns[model.technical_name];
    if (!onConflict) throw new QueryPlatformError(422, "IMPORT_MODEL_UNSUPPORTED", `The '${model.technical_name}' model does not have an import writer yet`);
    const sourceRows = Array.isArray(job.source_rows) ? job.source_rows as ImportSourceRow[] : [];
    const columnsResult = await database.client.from("query_import_columns").select("id,source_name").eq("job_id", id).order("column_index", { ascending: true });
    const mappingsResult = await database.client.from("query_import_mappings").select("source_column_id,field_path").eq("job_id", id);
    throwIfError(columnsResult.error, "read import columns");
    throwIfError(mappingsResult.error, "read import mappings");
    const sourceById = new Map(((columnsResult.data ?? []) as unknown as Row[]).map((row) => [String(row.id), String(row.source_name)]));
    const mappings = ((mappingsResult.data ?? []) as unknown as Row[]).flatMap((row) => {
      const source = sourceById.get(String(row.source_column_id));
      return source && typeof row.field_path === "string" ? [{ source, field: row.field_path }] : [];
    });
    const validation = validateImportRows(model, [...sourceById.values()], sourceRows, mappings);
    assertImportFieldPermissions(principal, model, validation.mappings);
    if (validation.valid_rows.length === 0) throw new QueryPlatformError(422, "IMPORT_NO_VALID_ROWS", "The import has no valid rows to write");
    for (let offset = 0; offset < validation.valid_rows.length; offset += 100) {
      const batch = validation.valid_rows.slice(offset, offset + 100).map((row) => ({
        organization_id: principal.organizationId,
        ...(typeof job.store_id === "string" ? { store_id: job.store_id } : {}),
        ...row
      }));
      const result = await database.client.from(model.table_name).upsert(batch, { onConflict });
      throwIfError(result.error, "write import batch");
      await database.client.from("query_import_jobs").update({ processed_rows: Math.min(offset + batch.length, validation.valid_rows.length), updated_at: new Date().toISOString() }).eq("id", id).eq("organization_id", principal.organizationId);
    }
    const completedAt = new Date().toISOString();
    const result = await database.client
      .from("query_import_jobs")
      .update({ status: "COMPLETED", processed_rows: validation.valid_rows.length, failed_rows: new Set(validation.errors.map((error) => error.row_number)).size, locked_at: null, locked_by: null, next_attempt_at: null, updated_at: completedAt, completed_at: completedAt })
      .eq("id", id)
      .eq("organization_id", principal.organizationId)
      .select("id,organization_id,store_id,created_by,model,status,source_file_name,total_rows,valid_rows,failed_rows,processed_rows,error_message,created_at,updated_at,completed_at")
      .single();
    if (result.error || !result.data) throwDatabaseError(result.error, "complete import job");
    const completed = mapImportJob(result.data as unknown as Row);
    await recordQueryJobAudit(database, principal, "QUERY_IMPORT_COMPLETED", "query_import_job", id, {
      model: completed.model,
      processedRows: completed.processed_rows,
      failedRows: completed.failed_rows
    });
    return completed;
  } catch (error) {
    const attempt = Number(current.attempt_count ?? 0) + 1;
    const retryable = isRetryableJobError(error) && attempt < QUERY_JOB_MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : "Import failed";
    await database.client.from("query_import_jobs").update({
      status: retryable ? "QUEUED" : "FAILED",
      error_message: message,
      locked_at: null,
      locked_by: null,
      next_attempt_at: retryable ? retryAt(attempt) : null,
      updated_at: new Date().toISOString()
    }).eq("id", id).eq("organization_id", principal.organizationId);
    await recordQueryJobAudit(database, principal, retryable ? "QUERY_IMPORT_RETRY_SCHEDULED" : "QUERY_IMPORT_FAILED", "query_import_job", id, { attempt, message });
    throw error;
  }
}

export async function cancelImportJob(database: Database, principal: SessionPrincipal, id: string): Promise<void> {
  importPermission(principal);
  const job = await getImportJobRow(database, principal, id);
  if (["COMPLETED", "CANCELLED"].includes(String(job.status))) throw new QueryPlatformError(409, "IMPORT_CANNOT_CANCEL", "This import job can no longer be cancelled");
  const result = await database.client.from("query_import_jobs").update({ status: "CANCELLED", updated_at: new Date().toISOString() }).eq("id", id).eq("organization_id", principal.organizationId);
  throwIfError(result.error, "cancel import job");
}

export interface ExportJobSummary {
  id: string;
  organization_id: string;
  store_id?: string | null;
  created_by: string;
  model: string;
  status: QueryJobStatus;
  format: "CSV" | "JSON" | "XLSX";
  selected_fields: string[];
  total_rows: number;
  processed_rows: number;
  file_name: string;
  content_type: string;
  content?: string;
  content_encoding?: "text" | "base64";
  error_message?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function spreadsheetColumn(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function spreadsheetCell(reference: string, value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function buildXlsxBase64(headers: string[], rows: unknown[][]): string {
  const matrix = [headers, ...rows];
  const sheetRows = matrix.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => spreadsheetCell(`${spreadsheetColumn(columnIndex)}${rowIndex + 1}`, value)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${spreadsheetColumn(Math.max(headers.length - 1, 0))}${Math.max(matrix.length, 1)}"/><sheetData>${sheetRows}</sheetData></worksheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const archive = zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml)
  });
  return toBase64(archive);
}

function mapExportJob(row: Row, includeContent = false): ExportJobSummary {
  const payload = row.result_payload && typeof row.result_payload === "object" ? row.result_payload as Row : {};
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    store_id: typeof row.store_id === "string" ? row.store_id : null,
    created_by: String(row.created_by),
    model: String(row.model),
    status: queryJobStatus(String(row.status)),
    format: row.format === "JSON" || row.format === "XLSX" ? row.format : "CSV",
    selected_fields: arrayOfStrings(row.selected_fields),
    total_rows: Number(row.total_rows ?? 0),
    processed_rows: Number(row.processed_rows ?? 0),
    file_name: typeof payload.fileName === "string" ? payload.fileName : `aevo-export-${String(row.id)}.${row.format === "JSON" ? "json" : row.format === "XLSX" ? "xlsx" : "csv"}`,
    content_type: typeof payload.contentType === "string" ? payload.contentType : "text/csv; charset=utf-8",
    content_encoding: payload.encoding === "base64" ? "base64" : "text",
    ...(includeContent && typeof payload.content === "string" ? { content: payload.content } : {}),
    error_message: typeof row.error_message === "string" ? row.error_message : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

export interface CreateExportJobInput {
  query: unknown;
  selectedFields?: string[];
  format: "CSV" | "JSON" | "XLSX";
  idempotencyKey: string;
  storeId?: string;
}

export interface CreateExportJobResult {
  exportJob: ExportJobSummary;
  created: boolean;
}

export async function createExportJob(database: Database, principal: SessionPrincipal, input: CreateExportJobInput): Promise<CreateExportJobResult> {
  exportPermission(principal);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new QueryPlatformError(400, "EXPORT_IDEMPOTENCY_REQUIRED", "An idempotency key is required for export jobs");
  const { model, query, fields } = await validateExportDefinition(database, principal, input.query, input.selectedFields);
  const fingerprint = await requestFingerprint({
    model: model.technical_name,
    query,
    selectedFields: fields,
    format: input.format,
    storeId: input.storeId ?? null
  });
  const existing = await database.client
    .from("query_export_jobs")
    .select("id,organization_id,store_id,created_by,model,status,selected_fields,format,total_rows,processed_rows,result_payload,error_message,request_fingerprint,created_at,updated_at,completed_at")
    .eq("organization_id", principal.organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  throwIfError(existing.error, "find export idempotency key");
  if (existing.data) {
    assertIdempotencyMatch(existing.data as unknown as Row, fingerprint, "EXPORT_IDEMPOTENCY_REUSED");
    return { exportJob: mapExportJob(existing.data as unknown as Row), created: false };
  }
  const initial = await database.client
    .from("query_export_jobs")
    .insert({
      organization_id: principal.organizationId,
      store_id: input.storeId ?? null,
      created_by: principal.userId,
      model: model.technical_name,
      status: "QUEUED",
      query_definition: query,
      selected_fields: fields,
      format: input.format,
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      next_attempt_at: new Date().toISOString()
    })
    .select("id,organization_id,store_id,created_by,model,status,selected_fields,format,total_rows,processed_rows,result_payload,error_message,request_fingerprint,created_at,updated_at,completed_at")
    .single();
  if (initial.error || !initial.data) {
    if (initial.error?.code === "23505") {
      const retry = await database.client
        .from("query_export_jobs")
        .select("id,organization_id,store_id,created_by,model,status,selected_fields,format,total_rows,processed_rows,result_payload,error_message,request_fingerprint,created_at,updated_at,completed_at")
        .eq("organization_id", principal.organizationId)
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (retry.error || !retry.data) throwDatabaseError(retry.error, "read idempotent export job");
      assertIdempotencyMatch(retry.data as unknown as Row, fingerprint, "EXPORT_IDEMPOTENCY_REUSED");
      return { exportJob: mapExportJob(retry.data as unknown as Row), created: false };
    }
    throwDatabaseError(initial.error, "create export job");
  }
  return { exportJob: mapExportJob(initial.data as unknown as Row), created: true };
}

export async function processExportJob(database: Database, principal: SessionPrincipal, id: string): Promise<ExportJobSummary> {
  exportPermission(principal);
  const currentResult = await database.client
    .from("query_export_jobs")
    .select("id,organization_id,store_id,created_by,model,status,selected_fields,format,total_rows,processed_rows,query_definition,result_payload,error_message,attempt_count,locked_at,locked_by,created_at,updated_at,completed_at")
    .eq("id", id)
    .eq("organization_id", principal.organizationId)
    .maybeSingle();
  throwIfError(currentResult.error, "find export job for processing");
  if (!currentResult.data) throw new QueryPlatformError(404, "EXPORT_JOB_NOT_FOUND", "Export job was not found");
  const current = currentResult.data as unknown as Row;
  if (String(current.created_by) !== principal.userId && !hasPermission(principal, "query.export")) throw new QueryPlatformError(403, "QUERY_EXPORT_REQUIRED", "You cannot process this export job");
  if (String(current.status) === "COMPLETED") return mapExportJob(current);
  if (String(current.status) === "CANCELLED") throw new QueryPlatformError(409, "EXPORT_CANCELLED", "The export job was cancelled");
  if (String(current.status) !== "QUEUED") return mapExportJob(current);

  const workerId = `query-export-${crypto.randomUUID()}`;
  const claimed = await database.client
    .from("query_export_jobs")
    .update({
      status: "PROCESSING",
      attempt_count: Number(current.attempt_count ?? 0) + 1,
      locked_at: new Date().toISOString(),
      locked_by: workerId,
      processing_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("organization_id", principal.organizationId)
    .eq("status", "QUEUED")
    .select("id")
    .maybeSingle();
  throwIfError(claimed.error, "claim export job");
  if (!claimed.data) {
    const latest = await database.client.from("query_export_jobs").select("id,organization_id,store_id,created_by,model,status,selected_fields,format,total_rows,processed_rows,result_payload,error_message,created_at,updated_at,completed_at").eq("id", id).eq("organization_id", principal.organizationId).single();
    throwIfError(latest.error, "read claimed export job");
    if (!latest.data) throw new QueryPlatformError(404, "EXPORT_JOB_NOT_FOUND", "Export job was not found");
    return mapExportJob(latest.data as unknown as Row);
  }

  try {
    const selectedFields = arrayOfStrings(current.selected_fields);
    const { model, query, fields } = await validateExportDefinition(database, principal, current.query_definition, selectedFields);
    const result = await executeQuery(database, principal, query, typeof current.store_id === "string" ? current.store_id : undefined);
    const fieldMetadata = fields.map((path) => model.fields.find((field) => field.path === path)).filter((field): field is QueryFieldMetadata => Boolean(field));
    const headers = fieldMetadata.map((field) => field.label);
    const values = result.rows.map((row) => fieldMetadata.map((field) => queryFieldValue(row, model, field.path)));
    const isJson = String(current.format) === "JSON";
    const isXlsx = String(current.format) === "XLSX";
    const content = isXlsx
      ? buildXlsxBase64(headers, values)
      : isJson
        ? JSON.stringify(result.rows)
        : [headers.map((header) => csvCell(header)).join(","), ...values.map((row) => row.map(csvCell).join(","))].join("\n");
    const completedAt = new Date().toISOString();
    const resultPayload = {
      fileName: `aevo-${model.technical_name.replaceAll(".", "-")}-${id}.${isJson ? "json" : isXlsx ? "xlsx" : "csv"}`,
      contentType: isJson
        ? "application/json; charset=utf-8"
        : isXlsx
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8",
      ...(isXlsx ? { encoding: "base64" } : {}),
      content
    };
    const updated = await database.client
      .from("query_export_jobs")
      .update({ status: "COMPLETED", total_rows: result.rows.length, processed_rows: result.rows.length, result_payload: resultPayload, locked_at: null, locked_by: null, next_attempt_at: null, updated_at: completedAt, completed_at: completedAt })
      .eq("id", id)
      .eq("organization_id", principal.organizationId)
      .select("id,organization_id,store_id,created_by,model,status,selected_fields,format,total_rows,processed_rows,result_payload,error_message,created_at,updated_at,completed_at")
    .single();
    if (updated.error || !updated.data) throwDatabaseError(updated.error, "complete export job");
    const completed = mapExportJob(updated.data as unknown as Row);
    await recordQueryJobAudit(database, principal, "QUERY_EXPORT_COMPLETED", "query_export_job", id, {
      model: completed.model,
      format: completed.format,
      processedRows: completed.processed_rows
    });
    return completed;
  } catch (error) {
    const attempt = Number(current.attempt_count ?? 0) + 1;
    const retryable = isRetryableJobError(error) && attempt < QUERY_JOB_MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : "Export failed";
    await database.client.from("query_export_jobs").update({
      status: retryable ? "QUEUED" : "FAILED",
      error_message: message,
      locked_at: null,
      locked_by: null,
      next_attempt_at: retryable ? retryAt(attempt) : null,
      updated_at: new Date().toISOString()
    }).eq("id", id).eq("organization_id", principal.organizationId);
    await recordQueryJobAudit(database, principal, retryable ? "QUERY_EXPORT_RETRY_SCHEDULED" : "QUERY_EXPORT_FAILED", "query_export_job", id, { attempt, message });
    throw error;
  }
}

async function getExportJobRow(database: Database, principal: SessionPrincipal, id: string): Promise<Row> {
  const result = await database.client
    .from("query_export_jobs")
    .select("id,organization_id,store_id,created_by,model,status,selected_fields,format,total_rows,processed_rows,result_payload,error_message,created_at,updated_at,completed_at")
    .eq("id", id)
    .eq("organization_id", principal.organizationId)
    .maybeSingle();
  throwIfError(result.error, "find export job");
  if (!result.data) throw new QueryPlatformError(404, "EXPORT_JOB_NOT_FOUND", "Export job was not found");
  const row = result.data as unknown as Row;
  if (String(row.created_by) !== principal.userId && !hasPermission(principal, "query.export")) throw new QueryPlatformError(403, "QUERY_EXPORT_REQUIRED", "You cannot access this export job");
  return row;
}

export async function listExportJobs(database: Database, principal: SessionPrincipal): Promise<ExportJobSummary[]> {
  exportPermission(principal);
  const result = await database.client
    .from("query_export_jobs")
    .select("id,organization_id,store_id,created_by,model,status,selected_fields,format,total_rows,processed_rows,result_payload,error_message,created_at,updated_at,completed_at")
    .eq("organization_id", principal.organizationId)
    .order("created_at", { ascending: false })
    .limit(100);
  throwIfError(result.error, "list export jobs");
  return ((result.data ?? []) as unknown as Row[]).map((row) => mapExportJob(row));
}

export async function getExportJob(database: Database, principal: SessionPrincipal, id: string, includeContent = false): Promise<ExportJobSummary> {
  return mapExportJob(await getExportJobRow(database, principal, id), includeContent);
}

export function queryJobStatus(value: string): QueryJobStatus {
  const statuses: QueryJobStatus[] = ["UPLOADED", "ANALYZING", "MAPPING", "VALIDATING", "READY", "QUEUED", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"];
  if (!statuses.includes(value as QueryJobStatus)) throw new QueryPlatformError(500, "QUERY_METADATA_INVALID", `Unsupported query job status '${value}'`);
  return value as QueryJobStatus;
}

/** Process a bounded batch of queued jobs for a standalone worker or a
 * gateway's best-effort in-process handoff. Each job resolves the creator's
 * current principal again before touching tenant data. */
export async function processPendingQueryJobs(database: Database, batchSize = 10): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 50);
  const staleBefore = new Date(Date.now() - QUERY_JOB_STALE_AFTER_MS).toISOString();
  const [recoveredImports, recoveredExports] = await Promise.all([
    database.client.from("query_import_jobs").update({ status: "QUEUED", locked_at: null, locked_by: null, next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("status", "PROCESSING").lt("locked_at", staleBefore),
    database.client.from("query_export_jobs").update({ status: "QUEUED", locked_at: null, locked_by: null, next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("status", "PROCESSING").lt("locked_at", staleBefore)
  ]);
  throwIfError(recoveredImports.error, "recover stale import jobs");
  throwIfError(recoveredExports.error, "recover stale export jobs");
  const [importsResult, exportsResult] = await Promise.all([
    database.client
      .from("query_import_jobs")
      .select("id,organization_id,created_by")
      .eq("status", "QUEUED")
      .or("next_attempt_at.is.null,next_attempt_at.lte." + new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(limit),
    database.client
      .from("query_export_jobs")
      .select("id,organization_id,created_by")
      .eq("status", "QUEUED")
      .or("next_attempt_at.is.null,next_attempt_at.lte." + new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(limit)
  ]);
  throwIfError(importsResult.error, "list queued import jobs");
  throwIfError(exportsResult.error, "list queued export jobs");
  let processed = 0;
  for (const row of (importsResult.data ?? []) as unknown as Row[]) {
    const principal = await resolvePrincipal(database, String(row.created_by), String(row.organization_id));
    if (!principal) continue;
    try {
      await processImportJob(database, principal, String(row.id));
      processed += 1;
    } catch (error) {
      console.warn(`[QueryWorker] import ${String(row.id)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const row of (exportsResult.data ?? []) as unknown as Row[]) {
    const principal = await resolvePrincipal(database, String(row.created_by), String(row.organization_id));
    if (!principal) continue;
    try {
      await processExportJob(database, principal, String(row.id));
      processed += 1;
    } catch (error) {
      console.warn(`[QueryWorker] export ${String(row.id)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return processed;
}
