import { describe, expect, test } from "bun:test";
import type { QueryModelMetadata } from "@aevo/contracts";
import { compileQuery, parseQueryText, QuerySyntaxError, validateImportRows, validateQuerySpec } from "../src";

const productModel: QueryModelMetadata = {
  technical_name: "product.product",
  table_name: "products",
  label: "Products",
  module: "catalog",
  description: "Organization catalog products",
  tenant_scope: "ORGANIZATION",
  read_permission: "catalog.read",
  default_search_fields: ["name", "sku", "description"],
  default_order: [{ field: "name", direction: "asc" }],
  status: "ACTIVE",
  fields: [
    { path: "name", label: "Name", field_type: "char", column_name: "name", capabilities: { search: true, filter: true, sort: true, group: true, export: true, import: true }, operators: ["contains", "eq", "neq", "starts_with", "ends_with"], sequence: 1 },
    { path: "sku", label: "SKU", field_type: "char", column_name: "sku", capabilities: { search: true, filter: true, sort: true, group: true, export: true, import: true }, operators: ["contains", "eq", "neq"], sequence: 2 },
    { path: "description", label: "Description", field_type: "text", column_name: "description", capabilities: { search: true, filter: true, sort: false, group: false, export: true, import: true }, operators: ["contains", "not_contains"], sequence: 3 },
    { path: "base_price_minor", label: "Price", field_type: "money", column_name: "base_price_minor", capabilities: { search: false, filter: true, sort: true, group: false, export: true, import: true }, operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"], sequence: 4 },
    { path: "created_at", label: "Created", field_type: "datetime", column_name: "created_at", capabilities: { search: false, filter: true, sort: true, group: true, export: true, import: false }, operators: ["before", "after", "on", "between", "today", "yesterday", "this_week", "this_month"], sequence: 5 }
  ]
};

describe("Aevo Query AST", () => {
  test("parses implicit AND, explicit boolean operators, and field comparisons", () => {
    const node = parseQueryText('สกรู AND (ขาว OR ดำ) AND base_price_minor:>100');
    expect(node).toEqual({
      type: "and",
      children: [
        { type: "text", value: "สกรู" },
        {
          type: "or",
          children: [
            { type: "text", value: "ขาว" },
            { type: "text", value: "ดำ" }
          ]
        },
        { type: "condition", field: "base_price_minor", operator: "gt", value: "100" }
      ]
    });
  });

  test("rejects malformed expressions", () => {
    expect(() => parseQueryText("name:(")).toThrow(QuerySyntaxError);
    expect(() => parseQueryText("price:>" )).toThrow(QuerySyntaxError);
  });

  test("parses slash boolean commands and named filter operators", () => {
    expect(parseQueryText("item /and test")).toEqual({
      type: "and",
      children: [
        { type: "text", value: "item" },
        { type: "text", value: "test" }
      ]
    });
    expect(parseQueryText('name:"test" /and gate')).toEqual({
      type: "and",
      children: [
        { type: "condition", field: "name", operator: "contains", value: "test" },
        { type: "text", value: "gate" }
      ]
    });
    expect(parseQueryText('name:"test AND se"')).toEqual({
      type: "condition", field: "name", operator: "contains", value: "test AND se"
    });
    expect(parseQueryText("name:starts_with:test AND description:not_contains:obsolete")).toEqual({
      type: "and",
      children: [
        { type: "condition", field: "name", operator: "starts_with", value: "test" },
        { type: "condition", field: "description", operator: "not_contains", value: "obsolete" }
      ]
    });
    expect(parseQueryText("base_price_minor:between:100,200")).toEqual({
      type: "condition", field: "base_price_minor", operator: "between", value: ["100", "200"]
    });
    expect(parseQueryText("created_at:today")).toEqual({
      type: "condition", field: "created_at", operator: "today"
    });
  });

  test("validates and normalizes field values against metadata", () => {
    const normalized = validateQuerySpec({
      version: 1,
      model: "product.product",
      where: { type: "condition", field: "base_price_minor", operator: "gt", value: "100" },
      fields: ["name", "base_price_minor"],
      pagination: { limit: 50, offset: 0 }
    }, productModel);
    expect(normalized.where).toEqual({ type: "condition", field: "base_price_minor", operator: "gt", value: 100 });
    expect(normalized.order_by).toEqual([{ field: "name", direction: "asc" }]);
  });

  test("compiles only metadata-owned columns into a safe PostgREST plan", () => {
    const normalized = validateQuerySpec({
      version: 1,
      model: "product.product",
      where: parseQueryText('name:"red,blue" OR base_price_minor:>100')
    }, productModel);
    const plan = compileQuery(normalized, productModel);
    expect(plan.table_name).toBe("products");
    expect(plan.select_columns).toContain("name");
    expect(plan.where_expression).toContain("or(");
    expect(plan.where_expression).not.toContain("drop table");
  });

  test("validates import rows through the same field metadata", () => {
    const result = validateImportRows(productModel, ["SKU", "Name", "Price"], [
      { SKU: "SC-001", Name: "White screw", Price: "120" },
      { SKU: "SC-002", Name: "Broken price", Price: "not-a-number" },
      { SKU: "", Name: "Missing sku", Price: "80" }
    ]);
    expect(result.mappings.map((mapping) => mapping.field)).toEqual(["sku", "name", "base_price_minor"]);
    expect(result.valid_rows).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
  });

  test("compiles nested relation fields and validates aggregate capabilities", () => {
    const model: QueryModelMetadata = {
      ...productModel,
      relations: [{
        path: "category",
        related_model: "product.category",
        related_table: "categories",
        embed_name: "category",
        source_column: "category_id",
        target_column: "id",
        foreign_key: "products_organization_id_category_id_fkey",
        cardinality: "many_to_one"
      }],
      default_search_fields: ["name", "category.name"],
      fields: [
        ...productModel.fields,
        { path: "category.name", label: "Category", field_type: "char", column_name: "name", relation_model: "product.category", relation_path: "category", capabilities: { search: true, filter: true, sort: false, group: true, export: true, import: false }, operators: ["contains", "eq"], sequence: 5 },
        { ...productModel.fields[3], path: "base_price_minor", capabilities: { ...productModel.fields[3].capabilities, aggregate: true }, sequence: 6 }
      ]
    };
    const normalized = validateQuerySpec({
      version: 1,
      model: model.technical_name,
      where: parseQueryText('category.name:"hardware"'),
      fields: ["name", "category.name"],
      aggregates: [{ function: "sum", field: "base_price_minor" }],
      pagination: { limit: 20, offset: 0 }
    }, model);
    const plan = compileQuery(normalized, model);
    expect(plan.select_columns).toContain("category:categories!products_organization_id_category_id_fkey!inner(name)");
    expect(plan.where_expression).toContain("category.name.ilike.*hardware*");
    expect(normalized.aggregates?.[0].alias).toBe("sum_base_price_minor");

    const combined = compileQuery(validateQuerySpec({
      version: 1,
      model: model.technical_name,
      where: { type: "and", children: [
        { type: "condition", field: "name", operator: "contains", value: "bolt" },
        { type: "condition", field: "category.name", operator: "contains", value: "hardware" }
      ] },
      fields: ["name", "category.name"],
      pagination: { limit: 20, offset: 0 }
    }, model), model);
    expect(combined.where_expression).toContain("name.ilike.*bolt*");
    expect(combined.where_foreign_expression).toContain("category.name.ilike.*hardware*");
  });

  test("compiles relative date operators with the organization timezone", () => {
    const normalized = validateQuerySpec({
      version: 1,
      model: "product.product",
      where: { type: "condition", field: "created_at", operator: "today" },
      fields: ["name", "created_at"],
      pagination: { limit: 20, offset: 0 }
    }, productModel);
    const plan = compileQuery(normalized, productModel, {
      timezone: "Asia/Bangkok",
      now: new Date("2026-09-18T02:00:00.000Z")
    });
    expect(plan.where_expression).toBe("and(created_at.gte.2026-09-17T17:00:00.000Z,created_at.lt.2026-09-18T17:00:00.000Z)");
  });
});
