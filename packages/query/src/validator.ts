import {
  queryFieldTypes,
  queryAggregateFunctions,
  queryOperators,
  type QueryConditionNode,
  type QueryAggregate,
  type QueryFieldMetadata,
  type QueryModelMetadata,
  type QueryNode,
  type QueryOrderBy,
  type QuerySpecV1,
  type QueryValue
} from "@aevo/contracts";

const MAX_QUERY_NODES = 64;
const MAX_LIMIT = 200;
const MAX_OFFSET = 100_000;
const MAX_AGGREGATES = 12;

export class QueryValidationError extends Error {
  readonly code = "QUERY_VALIDATION_ERROR";
  readonly path: string;

  constructor(message: string, path = "query") {
    super(message);
    this.name = "QueryValidationError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function fieldMap(model: QueryModelMetadata): Map<string, QueryFieldMetadata> {
  return new Map(model.fields.map((field) => [field.path, field]));
}

function normalizeScalar(value: unknown, field: QueryFieldMetadata, path: string): QueryValue {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new QueryValidationError("The list cannot be empty", path);
    return value.map((item, index) => normalizeScalar(item, field, `${path}[${index}]`)) as readonly (string | number | boolean | null)[];
  }

  if (!isScalar(value)) throw new QueryValidationError("Value must be a scalar or scalar list", path);
  if (value === null) return null;

  if (field.field_type === "integer" || field.field_type === "decimal" || field.field_type === "money" || field.field_type === "percentage" || field.field_type === "rating") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) throw new QueryValidationError("Value must be a finite number", path);
    return numeric;
  }
  if (field.field_type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new QueryValidationError("Value must be true or false", path);
  }
  return String(value);
}

function validateNode(node: unknown, model: QueryModelMetadata, fields: Map<string, QueryFieldMetadata>, state: { count: number }, path: string): QueryNode {
  state.count += 1;
  if (state.count > MAX_QUERY_NODES) throw new QueryValidationError(`Query exceeds the ${MAX_QUERY_NODES}-node limit`, path);
  if (!isRecord(node) || typeof node.type !== "string") throw new QueryValidationError("Invalid query node", path);

  if (node.type === "text") {
    const value = typeof node.value === "string" ? node.value.trim() : "";
    if (!value) throw new QueryValidationError("Text search terms cannot be empty", `${path}.value`);
    const searchable = model.default_search_fields.filter((field) => fields.get(field)?.capabilities.search);
    if (searchable.length === 0) throw new QueryValidationError("This model has no searchable fields", `${path}.value`);
    return { type: "text", value };
  }

  if (node.type === "condition") {
    const fieldName = typeof node.field === "string" ? node.field : "";
    const field = fields.get(fieldName);
    if (!field) throw new QueryValidationError(`Unknown field '${fieldName}'`, `${path}.field`);
    if (!field.capabilities.filter) throw new QueryValidationError(`Field '${fieldName}' cannot be filtered`, `${path}.field`);
    if (typeof node.operator !== "string" || !queryOperators.includes(node.operator as typeof queryOperators[number])) {
      throw new QueryValidationError(`Unsupported operator '${String(node.operator)}'`, `${path}.operator`);
    }
    const operator = node.operator as typeof queryOperators[number];
    if (!field.operators.includes(operator)) throw new QueryValidationError(`Operator '${operator}' is not allowed for '${fieldName}'`, `${path}.operator`);
    const valueRequired = !["is_empty", "is_not_empty", "today", "yesterday", "this_week", "this_month"].includes(operator);
    if (valueRequired && !("value" in node)) throw new QueryValidationError(`Operator '${operator}' requires a value`, `${path}.value`);
    if (!valueRequired && "value" in node && node.value !== undefined) throw new QueryValidationError(`Operator '${operator}' does not accept a value`, `${path}.value`);
    const value = valueRequired ? normalizeScalar(node.value, field, `${path}.value`) : undefined;
    if (operator === "between" && (!Array.isArray(value) || value.length !== 2)) {
      throw new QueryValidationError("between requires exactly two values", `${path}.value`);
    }
    if ((operator === "in" || operator === "not_in") && !Array.isArray(value)) {
      throw new QueryValidationError(`${operator} requires a list of values`, `${path}.value`);
    }
    return valueRequired ? { type: "condition", field: fieldName, operator, value } : { type: "condition", field: fieldName, operator };
  }

  if (node.type === "not") {
    return { type: "not", child: validateNode(node.child, model, fields, state, `${path}.child`) };
  }

  if (node.type === "and" || node.type === "or") {
    if (!Array.isArray(node.children) || node.children.length === 0) throw new QueryValidationError("Boolean groups require at least one child", `${path}.children`);
    const children = node.children.map((child, index) => validateNode(child, model, fields, state, `${path}.children[${index}]`));
    return { type: node.type, children };
  }

  throw new QueryValidationError(`Unknown node type '${node.type}'`, `${path}.type`);
}

function normalizeFields(input: unknown, model: QueryModelMetadata, fields: Map<string, QueryFieldMetadata>): string[] {
  const values = input === undefined ? model.fields.filter((field) => field.capabilities.search || field.capabilities.filter).sort((a, b) => a.sequence - b.sequence).map((field) => field.path) : input;
  if (!Array.isArray(values) || values.length === 0) throw new QueryValidationError("At least one output field is required", "query.fields");
  const result = values.map((value, index) => {
    if (typeof value !== "string") throw new QueryValidationError("Field names must be strings", `query.fields[${index}]`);
    const field = fields.get(value);
    if (!field) throw new QueryValidationError(`Unknown field '${value}'`, `query.fields[${index}]`);
    if (!field.capabilities.export && !field.capabilities.search && !field.capabilities.filter) throw new QueryValidationError(`Field '${value}' is not readable`, `query.fields[${index}]`);
    return value;
  });
  return [...new Set(result)];
}

function normalizeOrder(input: unknown, model: QueryModelMetadata, fields: Map<string, QueryFieldMetadata>): QueryOrderBy[] {
  const values = input === undefined ? model.default_order : input;
  if (!Array.isArray(values)) throw new QueryValidationError("order_by must be an array", "query.order_by");
  return values.map((value, index) => {
    if (!isRecord(value) || typeof value.field !== "string" || (value.direction !== "asc" && value.direction !== "desc")) {
      throw new QueryValidationError("Invalid order clause", `query.order_by[${index}]`);
    }
    const field = fields.get(value.field);
    if (!field || !field.capabilities.sort) throw new QueryValidationError(`Field '${value.field}' cannot be sorted`, `query.order_by[${index}].field`);
    return { field: value.field, direction: value.direction };
  });
}

function normalizeGroup(input: unknown, fields: Map<string, QueryFieldMetadata>): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new QueryValidationError("group_by must be an array", "query.group_by");
  return [...new Set(input.map((value, index) => {
    if (typeof value !== "string") throw new QueryValidationError("Group fields must be strings", `query.group_by[${index}]`);
    const field = fields.get(value);
    if (!field || !field.capabilities.group) throw new QueryValidationError(`Field '${value}' cannot be grouped`, `query.group_by[${index}]`);
    return value;
  }))];
}

function normalizeAggregates(input: unknown, fields: Map<string, QueryFieldMetadata>): QueryAggregate[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new QueryValidationError("aggregates must be an array", "query.aggregates");
  if (input.length > MAX_AGGREGATES) throw new QueryValidationError(`aggregates cannot contain more than ${MAX_AGGREGATES} items`, "query.aggregates");
  return input.map((value, index) => {
    if (!isRecord(value) || typeof value.function !== "string" || !queryAggregateFunctions.includes(value.function as typeof queryAggregateFunctions[number])) {
      throw new QueryValidationError("Invalid aggregate clause", `query.aggregates[${index}]`);
    }
    const aggregateFunction = value.function as typeof queryAggregateFunctions[number];
    const fieldName = typeof value.field === "string" ? value.field : undefined;
    if (aggregateFunction !== "count" && !fieldName) {
      throw new QueryValidationError(`Aggregate '${aggregateFunction}' requires a field`, `query.aggregates[${index}].field`);
    }
    const field = fieldName ? fields.get(fieldName) : undefined;
    if (fieldName && (!field || (!field.capabilities.aggregate && aggregateFunction !== "count"))) {
      throw new QueryValidationError(`Field '${fieldName}' cannot be aggregated`, `query.aggregates[${index}].field`);
    }
    const alias = value.alias === undefined
      ? `${aggregateFunction}_${fieldName?.replaceAll(".", "_") ?? "rows"}`
      : String(value.alias).trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(alias)) {
      throw new QueryValidationError("Aggregate alias must contain lowercase letters, numbers, and underscores", `query.aggregates[${index}].alias`);
    }
    return {
      function: aggregateFunction,
      ...(fieldName ? { field: fieldName } : {}),
      alias
    };
  });
}

export function validateQuerySpec(input: unknown, model: QueryModelMetadata): QuerySpecV1 {
  if (!isRecord(input)) throw new QueryValidationError("Query must be an object");
  if (input.version !== 1) throw new QueryValidationError("Only Query AST version 1 is supported", "query.version");
  if (input.model !== model.technical_name) throw new QueryValidationError(`Query model must be '${model.technical_name}'`, "query.model");
  if (model.status !== "ACTIVE") throw new QueryValidationError(`Model '${model.technical_name}' is not active`, "query.model");
  const fields = fieldMap(model);
  const where = input.where === undefined || input.where === null ? null : validateNode(input.where, model, fields, { count: 0 }, "query.where");
  const aggregates = normalizeAggregates(input.aggregates, fields);
  const pagination = input.pagination === undefined ? { limit: 80, offset: 0 } : input.pagination;
  if (!isRecord(pagination)) throw new QueryValidationError("pagination must be an object", "query.pagination");
  const limit = pagination.limit;
  const offset = pagination.offset;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new QueryValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`, "query.pagination.limit");
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new QueryValidationError(`offset must be an integer between 0 and ${MAX_OFFSET}`, "query.pagination.offset");
  return {
    version: 1,
    model: model.technical_name,
    where,
    fields: normalizeFields(input.fields, model, fields),
    order_by: normalizeOrder(input.order_by, model, fields),
    group_by: normalizeGroup(input.group_by, fields),
    aggregates,
    pagination: { limit, offset }
  };
}

export function assertQueryFieldType(fieldType: string): void {
  if (!queryFieldTypes.includes(fieldType as typeof queryFieldTypes[number])) throw new QueryValidationError(`Unsupported field type '${fieldType}'`, "metadata.field_type");
}
