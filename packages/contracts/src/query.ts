export const queryNodeTypes = ["text", "condition", "and", "or", "not"] as const;
export type QueryNodeType = (typeof queryNodeTypes)[number];

export const queryOperators = [
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "between",
  "is_empty",
  "is_not_empty",
  "before",
  "after",
  "on",
  "today",
  "yesterday",
  "this_week",
  "this_month"
] as const;
export type QueryOperator = (typeof queryOperators)[number];

export type QueryScalar = string | number | boolean | null;
export type QueryValue = QueryScalar | readonly QueryScalar[];

export interface QueryTextNode {
  type: "text";
  value: string;
}

export interface QueryConditionNode {
  type: "condition";
  field: string;
  operator: QueryOperator;
  value?: QueryValue;
}

export interface QueryBooleanNode {
  type: "and" | "or";
  children: QueryNode[];
}

export interface QueryNotNode {
  type: "not";
  child: QueryNode;
}

export type QueryNode = QueryTextNode | QueryConditionNode | QueryBooleanNode | QueryNotNode;

export interface QueryOrderBy {
  field: string;
  direction: "asc" | "desc";
}

export interface QueryPagination {
  limit: number;
  offset: number;
}

export const queryAggregateFunctions = ["count", "sum", "avg", "min", "max"] as const;
export type QueryAggregateFunction = (typeof queryAggregateFunctions)[number];

export interface QueryAggregate {
  function: QueryAggregateFunction;
  field?: string;
  alias?: string;
}

export interface QuerySpecV1 {
  version: 1;
  model: string;
  where?: QueryNode | null;
  fields?: string[];
  order_by?: QueryOrderBy[];
  group_by?: string[];
  aggregates?: QueryAggregate[];
  pagination?: QueryPagination;
}

export const queryScopeTypes = ["ORGANIZATION", "STORE", "PLATFORM"] as const;
export type QueryScopeType = (typeof queryScopeTypes)[number];

export const queryModelStatuses = ["ACTIVE", "ARCHIVED"] as const;
export type QueryModelStatus = (typeof queryModelStatuses)[number];

export const queryFieldTypes = [
  "char",
  "text",
  "integer",
  "decimal",
  "money",
  "boolean",
  "date",
  "datetime",
  "time",
  "selection",
  "many2one",
  "one2many",
  "many2many",
  "json",
  "file",
  "image",
  "reference",
  "geo",
  "duration",
  "percentage",
  "rating",
  "color",
  "phone",
  "email"
] as const;
export type QueryFieldType = (typeof queryFieldTypes)[number];

export interface QueryFieldCapabilities {
  search: boolean;
  filter: boolean;
  sort: boolean;
  group: boolean;
  export: boolean;
  import: boolean;
  aggregate?: boolean;
  bulk_edit?: boolean;
}

export interface QueryFieldMetadata {
  path: string;
  label: string;
  field_type: QueryFieldType;
  column_name: string;
  relation_model?: string | null;
  relation_path?: string | null;
  capabilities: QueryFieldCapabilities;
  operators: QueryOperator[];
  read_permission?: string | null;
  write_permission?: string | null;
  sequence: number;
}

export interface QueryRelationMetadata {
  path: string;
  related_model: string;
  related_table: string;
  embed_name: string;
  source_column: string;
  target_column: string;
  foreign_key?: string | null;
  cardinality: "many_to_one" | "one_to_many" | "one_to_one";
}

export const queryViewTypes = ["LIST", "KANBAN", "PIVOT", "CHART"] as const;
export type QueryViewType = (typeof queryViewTypes)[number];

export interface QueryModelViewMetadata {
  view_key: string;
  label: string;
  view_type: QueryViewType;
  columns: string[];
  default_order: QueryOrderBy[];
  default_group_by: string[];
  status: QueryModelStatus;
}

export interface QuerySearchDefinitionMetadata {
  definition_key: string;
  label: string;
  default_search_fields: string[];
  default_order: QueryOrderBy[];
  operator_overrides: Record<string, QueryOperator[]>;
  status: QueryModelStatus;
  is_system: boolean;
}

export interface QueryGroupResult {
  key: string;
  count: number;
  aggregates?: Record<string, number | null>;
}

export interface QueryModelMetadata {
  technical_name: string;
  table_name: string;
  label: string;
  module: string;
  description: string;
  tenant_scope: QueryScopeType;
  read_permission: string;
  default_search_fields: string[];
  default_order: QueryOrderBy[];
  status: QueryModelStatus;
  fields: QueryFieldMetadata[];
  relations?: QueryRelationMetadata[];
  views?: QueryModelViewMetadata[];
  search_definitions?: QuerySearchDefinitionMetadata[];
}

export const savedQueryScopes = ["PRIVATE", "TEAM", "STORE", "ORGANIZATION", "SYSTEM"] as const;
export type SavedQueryScope = (typeof savedQueryScopes)[number];

export interface SavedQueryRecord {
  id: string;
  organization_id: string;
  store_id?: string | null;
  owner_user_id: string;
  name: string;
  model: string;
  scope: SavedQueryScope;
  query: QuerySpecV1;
  status: "ACTIVE" | "ARCHIVED";
  created_at: string;
  updated_at: string;
}

export interface QueryHistoryRecord {
  id: string;
  organization_id: string;
  store_id?: string | null;
  user_id: string;
  model: string;
  query: QuerySpecV1;
  result_count: number;
  duration_ms?: number | null;
  created_at: string;
}

export interface ExportTemplateRecord {
  id: string;
  organization_id: string;
  store_id?: string | null;
  owner_user_id: string;
  name: string;
  model: string;
  scope: SavedQueryScope;
  query: QuerySpecV1;
  selected_fields: string[];
  status: "ACTIVE" | "ARCHIVED";
  created_at: string;
  updated_at: string;
}

export const queryJobStatuses = [
  "UPLOADED",
  "ANALYZING",
  "MAPPING",
  "VALIDATING",
  "READY",
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED"
] as const;
export type QueryJobStatus = (typeof queryJobStatuses)[number];

export interface QueryImportJobSummary {
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

export interface QueryImportMappingRecord {
  source: string;
  field: string;
  confidence?: number | null;
}

export interface QueryImportErrorRecord {
  row_number: number;
  field_path?: string | null;
  error_code: string;
  message: string;
  source_data: Record<string, unknown>;
}

export interface QueryExportJobSummary {
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
