import type { QueryFieldMetadata, QueryModelMetadata, QueryNode, QuerySpecV1, QueryValue } from "@aevo/contracts";
import { QueryValidationError } from "./validator";

export interface QueryPlan {
  table_name: string;
  select_columns: string[];
  where_expression: string | null;
  where_foreign_expression: string | null;
  where_foreign_table: string | null;
  order_by: QuerySpecV1["order_by"];
  group_by: string[];
  limit: number;
  offset: number;
}

export interface QueryCompileOptions {
  /** IANA timezone used by relative date operators. */
  timezone?: string;
  /** Injectable clock for deterministic tests and replayed jobs. */
  now?: Date;
}

function fieldByPath(model: QueryModelMetadata, path: string): QueryFieldMetadata {
  const field = model.fields.find((candidate) => candidate.path === path);
  if (!field) throw new QueryValidationError(`Unknown field '${path}'`, path);
  return field;
}

function relationForField(model: QueryModelMetadata, field: QueryFieldMetadata) {
  if (!field.relation_path) return undefined;
  const relation = (model.relations ?? []).find((candidate) => candidate.path === field.relation_path);
  if (!relation) throw new QueryValidationError(`Relation '${field.relation_path}' is not registered`, field.path);
  return relation;
}

function queryColumn(model: QueryModelMetadata, field: QueryFieldMetadata): string {
  const relation = relationForField(model, field);
  return relation ? `${relation.embed_name}.${field.column_name}` : field.column_name;
}

function selectExpressions(model: QueryModelMetadata, fields: string[], innerRelations: Set<string> = new Set()): string[] {
  const baseFields = new Set<string>();
  const relationFields = new Map<string, { relation: NonNullable<QueryModelMetadata["relations"]>[number]; columns: Set<string> }>();
  for (const path of fields) {
    const field = fieldByPath(model, path);
    const relation = relationForField(model, field);
    if (!relation) {
      baseFields.add(field.column_name);
      continue;
    }
    const existing = relationFields.get(relation.path) ?? { relation, columns: new Set<string>() };
    existing.columns.add(field.column_name);
    relationFields.set(relation.path, existing);
  }
  for (const relationPath of innerRelations) {
    if (relationFields.has(relationPath)) continue;
    const relation = (model.relations ?? []).find((candidate) => candidate.path === relationPath);
    const relationField = model.fields.find((field) => field.relation_path === relationPath);
    if (relation && relationField) relationFields.set(relationPath, { relation, columns: new Set([relationField.column_name]) });
  }
  return [
    ...baseFields,
    ...[...relationFields.values()].map(({ relation, columns }) => {
      const foreignKey = relation.foreign_key ? `!${relation.foreign_key}` : "";
      const inner = innerRelations.has(relation.path) ? "!inner" : "";
      return `${relation.embed_name}:${relation.related_table}${foreignKey}${inner}(${[...columns].join(",")})`;
    })
  ];
}

interface RelationScope {
  relationPaths: Set<string>;
  hasBaseField: boolean;
}

function relationScopeForNode(node: QueryNode | null | undefined, model: QueryModelMetadata): RelationScope {
  if (!node) return { relationPaths: new Set(), hasBaseField: false };
  if (node.type === "condition") {
    const field = fieldByPath(model, node.field);
    return field.relation_path
      ? { relationPaths: new Set([field.relation_path]), hasBaseField: false }
      : { relationPaths: new Set(), hasBaseField: true };
  }
  if (node.type === "text") {
    const searchable = model.default_search_fields.map((fieldName) => fieldByPath(model, fieldName));
    const hasBaseField = searchable.some((field) => !field.relation_path);
    return {
      hasBaseField,
      relationPaths: hasBaseField ? new Set() : new Set(searchable.flatMap((field) => field.relation_path ? [field.relation_path] : []))
    };
  }
  if (node.type === "not") return relationScopeForNode(node.child, model);
  return node.children.reduce<RelationScope>((scope, child) => {
    const childScope = relationScopeForNode(child, model);
    return {
      hasBaseField: scope.hasBaseField || childScope.hasBaseField,
      relationPaths: new Set([...scope.relationPaths, ...childScope.relationPaths])
    };
  }, { relationPaths: new Set(), hasBaseField: false });
}

function escapePostgrestToken(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll(",", "\\,")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("*", "\\*")
    .replaceAll(".", "\\.");
}

function scalarToken(value: QueryValue): string {
  if (Array.isArray(value)) throw new QueryValidationError("A list cannot be used as a scalar filter value");
  if (value === null) return "null";
  if (typeof value === "string") return escapePostgrestToken(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function datePartsAt(value: Date, timezone: string): DateParts {
  if (!Number.isFinite(value.getTime())) throw new QueryValidationError("Query clock must be a valid date");
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(value);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return {
      year: values.year,
      month: values.month,
      day: values.day,
      hour: values.hour,
      minute: values.minute,
      second: values.second
    };
  } catch {
    throw new QueryValidationError(`Invalid query timezone '${timezone}'`, "query.timezone");
  }
}

function dateKey(parts: DateParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDays(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return dateKey({ year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(), hour: 0, minute: 0, second: 0 });
}

function startOfLocalDayIso(key: string, timezone: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = datePartsAt(new Date(timestamp), timezone);
    const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    timestamp = target - (wallClock - timestamp);
  }
  return new Date(timestamp).toISOString();
}

function relativeDateRange(operator: Extract<QueryNode, { type: "condition" }>["operator"], field: QueryFieldMetadata, options: QueryCompileOptions): { start: string; end: string } {
  const timezone = options.timezone ?? "UTC";
  const now = options.now ?? new Date();
  const today = dateKey(datePartsAt(now, timezone));
  if (operator === "today") return { start: today, end: addDays(today, 1) };
  if (operator === "yesterday") {
    const start = addDays(today, -1);
    return { start, end: today };
  }

  const todayDate = new Date(`${today}T00:00:00Z`);
  const dayOfWeek = todayDate.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  if (operator === "this_week") {
    const start = addDays(today, mondayOffset);
    return { start, end: addDays(start, 7) };
  }
  if (operator === "this_month") {
    const [year, month] = today.split("-").map(Number);
    const start = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
    return { start, end: addDays(start, new Date(Date.UTC(year, month, 0)).getUTCDate()) };
  }
  throw new QueryValidationError(`Unsupported relative date operator '${operator}'`, field.path);
}

function relativeDateExpression(column: string, node: Extract<QueryNode, { type: "condition" }>, field: QueryFieldMetadata, options: QueryCompileOptions): string {
  const range = relativeDateRange(node.operator, field, options);
  if (field.field_type === "date") return `and(${column}.gte.${range.start},${column}.lt.${range.end})`;
  const start = startOfLocalDayIso(range.start, options.timezone ?? "UTC");
  const end = startOfLocalDayIso(range.end, options.timezone ?? "UTC");
  return `and(${column}.gte.${start},${column}.lt.${end})`;
}

function conditionExpression(node: Extract<QueryNode, { type: "condition" }>, model: QueryModelMetadata, options: QueryCompileOptions): string {
  const field = fieldByPath(model, node.field);
  const column = queryColumn(model, field);
  const value = node.value;
  switch (node.operator) {
    case "contains": return `${column}.ilike.*${scalarToken(value ?? "")}*`;
    case "not_contains": return `${column}.not.ilike.*${scalarToken(value ?? "")}*`;
    case "starts_with": return `${column}.ilike.${scalarToken(value ?? "")}*`;
    case "ends_with": return `${column}.ilike.*${scalarToken(value ?? "")}`;
    case "eq": return value === null ? `${column}.is.null` : `${column}.eq.${scalarToken(value ?? "")}`;
    case "neq": return value === null ? `${column}.not.is.null` : `${column}.neq.${scalarToken(value ?? "")}`;
    case "gt": return `${column}.gt.${scalarToken(value ?? "")}`;
    case "gte": return `${column}.gte.${scalarToken(value ?? "")}`;
    case "lt": return `${column}.lt.${scalarToken(value ?? "")}`;
    case "lte": return `${column}.lte.${scalarToken(value ?? "")}`;
    case "in": {
      if (!Array.isArray(value)) throw new QueryValidationError("in requires a list");
      return `${column}.in.(${value.map((item) => scalarToken(item)).join(",")})`;
    }
    case "not_in": {
      if (!Array.isArray(value)) throw new QueryValidationError("not_in requires a list");
      return `${column}.not.in.(${value.map((item) => scalarToken(item)).join(",")})`;
    }
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) throw new QueryValidationError("between requires two values");
      return `and(${column}.gte.${scalarToken(value[0])},${column}.lte.${scalarToken(value[1])})`;
    }
    case "is_empty": return `${column}.is.null`;
    case "is_not_empty": return `${column}.not.is.null`;
    case "before": return `${column}.lt.${scalarToken(value ?? "")}`;
    case "after": return `${column}.gt.${scalarToken(value ?? "")}`;
    case "on": return `${column}.eq.${scalarToken(value ?? "")}`;
    case "today":
    case "yesterday":
    case "this_week":
    case "this_month":
      if (field.field_type !== "date" && field.field_type !== "datetime") {
        throw new QueryValidationError(`Relative date operator '${node.operator}' requires a date or datetime field`, node.field);
      }
      return relativeDateExpression(column, node, field, options);
  }
}

function nodeExpression(node: QueryNode, model: QueryModelMetadata, options: QueryCompileOptions): string {
  switch (node.type) {
    case "text": {
      const searchable = model.default_search_fields.map((fieldName) => fieldByPath(model, fieldName)).filter((field) => !field.relation_path).map((field) => {
        return `${queryColumn(model, field)}.ilike.*${escapePostgrestToken(node.value)}*`;
      });
      const relationOnlySearchable = model.default_search_fields.map((fieldName) => fieldByPath(model, fieldName)).filter((field) => field.relation_path).map((field) => {
        return `${queryColumn(model, field)}.ilike.*${escapePostgrestToken(node.value)}*`;
      });
      const clauses = searchable.length > 0 ? searchable : relationOnlySearchable;
      if (clauses.length === 0) throw new QueryValidationError("Model has no searchable fields");
      return clauses.length === 1 ? clauses[0] : `or(${clauses.join(",")})`;
    }
    case "condition": return conditionExpression(node, model, options);
    case "and": return node.children.length === 1 ? nodeExpression(node.children[0], model, options) : `and(${node.children.map((child) => nodeExpression(child, model, options)).join(",")})`;
    case "or": return node.children.length === 1 ? nodeExpression(node.children[0], model, options) : `or(${node.children.map((child) => nodeExpression(child, model, options)).join(",")})`;
    case "not": return `not.${nodeExpression(node.child, model, options)}`;
  }
}

export function compileQuery(spec: QuerySpecV1, model: QueryModelMetadata, options: QueryCompileOptions = {}): QueryPlan {
  const fields = spec.fields ?? [];
  const relationScope = relationScopeForNode(spec.where, model);
  let whereExpression = spec.where ? nodeExpression(spec.where, model, options) : null;
  let whereForeignExpression: string | null = null;
  if (relationScope.hasBaseField && relationScope.relationPaths.size > 0) {
    if (spec.where?.type !== "and" || relationScope.relationPaths.size !== 1) {
      throw new QueryValidationError("A relation filter can only be combined with base-table filters using AND", "query.where");
    }
    const baseChildren: QueryNode[] = [];
    const relationChildren: QueryNode[] = [];
    for (const child of spec.where.children) {
      const childScope = relationScopeForNode(child, model);
      if (childScope.hasBaseField && childScope.relationPaths.size === 0) baseChildren.push(child);
      else if (!childScope.hasBaseField && childScope.relationPaths.size === 1) relationChildren.push(child);
      else throw new QueryValidationError("Nested relation boolean groups must be separated from base-table filters", "query.where");
    }
    if (baseChildren.length === 0 || relationChildren.length === 0) {
      throw new QueryValidationError("A relation filter must be combined with a base-table filter using AND", "query.where");
    }
    whereExpression = baseChildren.length === 1 ? nodeExpression(baseChildren[0], model, options) : `and(${baseChildren.map((child) => nodeExpression(child, model, options)).join(",")})`;
    whereForeignExpression = relationChildren.length === 1 ? nodeExpression(relationChildren[0], model, options) : `and(${relationChildren.map((child) => nodeExpression(child, model, options)).join(",")})`;
  }
  const relationPaths = relationScope.relationPaths;
  const selectColumns = selectExpressions(model, fields, relationPaths);
  const order = (spec.order_by ?? []).map((item) => {
    const field = fieldByPath(model, item.field);
    if (relationForField(model, field)) throw new QueryValidationError(`Relation field '${item.field}' cannot be sorted by this adapter yet`, item.field);
    return { ...item, field: field.column_name };
  });
  const group = (spec.group_by ?? []).map((path) => {
    fieldByPath(model, path);
    return path;
  });
  return {
    table_name: model.table_name,
    select_columns: [...new Set(selectColumns)],
    where_expression: whereExpression,
    where_foreign_expression: whereForeignExpression,
    where_foreign_table: relationPaths.size === 1
      ? (model.relations ?? []).find((relation) => relation.path === [...relationPaths][0])?.embed_name ?? null
      : null,
    order_by: order,
    group_by: group,
    limit: spec.pagination?.limit ?? 80,
    offset: spec.pagination?.offset ?? 0
  };
}
