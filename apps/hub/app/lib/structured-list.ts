export interface StructuredListQuery {
  q: string;
  role: string;
  status: string;
  scope: string;
  sort: string;
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
  columns: string[];
}

export interface StructuredListOptions {
  columns: readonly string[];
  defaultColumns: readonly string[];
  sorts: readonly string[];
  pageSizes?: readonly number[];
}

function positiveInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseStructuredListQuery(params: URLSearchParams, options: StructuredListOptions): StructuredListQuery {
  const pageSizes = options.pageSizes ?? [10, 25, 50];
  const requestedSize = positiveInteger(params.get("pageSize"), 25);
  const columns = params.getAll("columns").filter((column) => options.columns.includes(column));
  const sortValue = params.get("sort") ?? options.sorts[0] ?? "";
  return {
    q: (params.get("q") ?? "").trim().slice(0, 160),
    role: (params.get("role") ?? "").trim().slice(0, 64),
    status: (params.get("status") ?? "").trim().slice(0, 32),
    scope: (params.get("scope") ?? "").trim().slice(0, 32),
    sort: options.sorts.includes(sortValue) ? sortValue : options.sorts[0] ?? "",
    direction: params.get("direction") === "desc" ? "desc" : "asc",
    page: positiveInteger(params.get("page"), 1),
    pageSize: pageSizes.includes(requestedSize) ? requestedSize : pageSizes[0] ?? 25,
    columns: columns.length > 0 ? [...new Set(columns)] : [...options.defaultColumns],
  };
}

export interface PageSlice<T> {
  items: T[];
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  firstItem: number;
  lastItem: number;
}

export function paginate<T>(items: readonly T[], requestedPage: number, pageSize: number): PageSlice<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    pageCount,
    total,
    firstItem: total === 0 ? 0 : start + 1,
    lastItem: Math.min(start + pageSize, total),
  };
}

export function queryWithPage(params: URLSearchParams, page: number): string {
  const next = new URLSearchParams(params);
  next.set("page", String(page));
  return `?${next.toString()}`;
}
