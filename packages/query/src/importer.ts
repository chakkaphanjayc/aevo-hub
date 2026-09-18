import type { QueryFieldMetadata, QueryModelMetadata } from "@aevo/contracts";

export type ImportSourceRow = Record<string, unknown>;
export type ImportValue = string | number | boolean | null;

export interface ImportMapping {
  source: string;
  field: string;
}

export interface ImportValidationError {
  row_number: number;
  field_path?: string;
  error_code: string;
  message: string;
  source_data: ImportSourceRow;
}

export interface ImportValidationResult {
  mappings: ImportMapping[];
  valid_rows: Array<Record<string, ImportValue>>;
  errors: ImportValidationError[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function fieldByPath(model: QueryModelMetadata, path: string): QueryFieldMetadata | undefined {
  return model.fields.find((field) => field.path === path);
}

function inferField(model: QueryModelMetadata, source: string): QueryFieldMetadata | undefined {
  const normalized = normalize(source);
  return model.fields
    .filter((field) => field.capabilities.import)
    .sort((left, right) => left.sequence - right.sequence)
    .find((field) => [field.path, field.column_name, field.label].some((candidate) => normalize(candidate) === normalized));
}

function toImportValue(value: unknown, field: QueryFieldMetadata): ImportValue {
  if (value === null || value === undefined || value === "") return null;
  if (field.field_type === "integer" || field.field_type === "decimal" || field.field_type === "money" || field.field_type === "percentage" || field.field_type === "rating") {
    const numberValue = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(numberValue)) throw new Error("VALUE_NOT_NUMERIC");
    return numberValue;
  }
  if (field.field_type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
    throw new Error("VALUE_NOT_BOOLEAN");
  }
  const text = String(value).trim();
  if (text.length > 2000) throw new Error("VALUE_TOO_LONG");
  return text;
}

function requiredField(model: QueryModelMetadata, field: QueryFieldMetadata): boolean {
  if (model.technical_name === "product.product") return field.path === "sku" || field.path === "name";
  if (model.technical_name === "product.category") return field.path === "code" || field.path === "name";
  if (model.technical_name === "res.store") return field.path === "code" || field.path === "name";
  return false;
}

export function validateImportRows(
  model: QueryModelMetadata,
  columns: string[],
  rows: ImportSourceRow[],
  requestedMappings: ImportMapping[] = []
): ImportValidationResult {
  const mappings: ImportMapping[] = [];
  for (const column of columns) {
    const requested = requestedMappings.find((mapping) => mapping.source === column);
    const field = requested ? fieldByPath(model, requested.field) : inferField(model, column);
    if (field?.capabilities.import) mappings.push({ source: column, field: field.path });
  }

  const mappedBySource = new Map(mappings.map((mapping) => [mapping.source, mapping.field]));
  const errors: ImportValidationError[] = [];
  const validRows: Array<Record<string, ImportValue>> = [];

  rows.forEach((sourceData, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const output: Record<string, ImportValue> = {};
    let rowValid = true;
    for (const mapping of mappings) {
      const field = fieldByPath(model, mapping.field);
      if (!field) continue;
      try {
        const value = toImportValue(sourceData[mapping.source], field);
        if (value === null && requiredField(model, field)) {
          throw new Error("VALUE_REQUIRED");
        }
        output[field.column_name] = value;
      } catch (error) {
        rowValid = false;
        const code = error instanceof Error ? error.message : "VALUE_INVALID";
        errors.push({
          row_number: rowNumber,
          field_path: field.path,
          error_code: code,
          message: `${field.label}: ${code.toLowerCase().replaceAll("_", " ")}`,
          source_data: sourceData
        });
      }
    }

    for (const field of model.fields.filter((candidate) => candidate.capabilities.import && requiredField(model, candidate))) {
      if (!mappings.some((mapping) => mapping.field === field.path)) {
        rowValid = false;
        errors.push({
          row_number: rowNumber,
          field_path: field.path,
          error_code: "FIELD_NOT_MAPPED",
          message: `${field.label}: field is not mapped`,
          source_data: sourceData
        });
      }
    }

    if (rowValid) validRows.push(output);
  });

  return { mappings, valid_rows: validRows, errors };
}
