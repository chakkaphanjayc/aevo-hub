import { createSlashCommandMenu, parseSlashToken } from "./slash-command.js";

const modelCache = new Map();
const modelListCache = new Map();
const modelListPromises = new Map();
let searchInstanceSequence = 0;
const noValueOperators = new Set(["is_empty", "is_not_empty", "today", "yesterday", "this_week", "this_month"]);
const textSearchFieldTypes = new Set(["char", "text", "email", "phone", "selection", "many2one"]);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);
}

function readableFields(model) {
  return (model?.fields || [])
    .filter((field) => field.capabilities?.search || field.capabilities?.filter || field.capabilities?.sort || field.capabilities?.export)
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

function filterableFields(model) {
  return readableFields(model).filter((field) => field.capabilities?.filter);
}

function listViewFieldPaths(model) {
  const view = (model?.views || []).find((candidate) => candidate.view_type === "LIST" && candidate.status === "ACTIVE");
  return Array.isArray(view?.columns) ? view.columns : [];
}

function isIdentifierField(field) {
  return field?.path === "id" || field?.path?.endsWith("_id");
}

function isIdentifierQuery(value) {
  const query = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(query) || /^\d{6,}$/u.test(query);
}

function searchOperatorForField(field, query) {
  const operators = Array.isArray(field?.operators) ? field.operators : [];
  if (!field?.capabilities?.filter) return null;
  if (operators.includes("contains")) return "contains";
  if (field.capabilities.search && operators.includes("eq")) return "eq";
  if (isIdentifierField(field) && operators.includes("eq")) return "eq";
  if (textSearchFieldTypes.has(field.field_type) && operators.includes("eq") && field.capabilities.search) return "eq";
  return null;
}

function searchFields(model, requestedFields, query) {
  const requested = Array.isArray(requestedFields) && requestedFields.length > 0
    ? requestedFields
    : listViewFieldPaths(model);
  const candidates = requested.length > 0
    ? requested.map((path) => fieldByPath(model, path)).filter(Boolean)
    : readableFields(model);
  const seen = new Set();
  return candidates
    .filter((field) => {
      if (!field || seen.has(field.path) || !searchOperatorForField(field, query)) return false;
      seen.add(field.path);
      return true;
    })
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

function quoteQueryText(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function searchFieldLabel(model, field) {
  if (model?.technical_name === "admin.organization" && field.path === "id") return "Tenant ID";
  return field.label;
}

function quoteStateBefore(value, end) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < end; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") quote = character;
  }
  return quote;
}

function trailingBooleanSearchTerm(raw) {
  const match = raw.match(/(?:^|\s)\/?(?:and|or|not)\s+([^()\s:]+)$/iu);
  if (!match || typeof match.index !== "number") return null;
  const operatorOffset = match[0].search(/\/?(?:and|or|not)/iu);
  const operatorStart = match.index + Math.max(operatorOffset, 0);
  if (quoteStateBefore(raw, operatorStart)) return null;
  const query = match[1];
  return { query, start: raw.length - query.length, end: raw.length };
}

function parseFieldSearchTrigger(value) {
  const raw = String(value || "");
  const query = raw.trim();
  if (!query) return null;
  const booleanTerm = trailingBooleanSearchTerm(raw);
  if (booleanTerm) return { ...booleanTerm, kind: "field" };
  if (/(?:^|\s)\/[^\s()]*/u.test(raw) || query.includes(":")) return null;
  const start = raw.indexOf(query);
  return { query, start: Math.max(start, 0), end: raw.length, kind: "field" };
}

function sortableFields(model) {
  return readableFields(model).filter((field) => field.capabilities?.sort);
}

function groupableFields(model) {
  return readableFields(model).filter((field) => field.capabilities?.group);
}

function fieldByPath(model, path) {
  return (model?.fields || []).find((field) => field.path === path);
}

function fieldInputType(field) {
  if (["integer", "decimal", "money", "percentage", "rating"].includes(field?.field_type)) return "number";
  if (field?.field_type === "date" || field?.field_type === "datetime") return "date";
  return "text";
}

function resolveValue(value) {
  return typeof value === "function" ? value() : value;
}

function combineWhere(left, right) {
  if (!left) return right;
  if (!right) return left;
  return { type: "and", children: [left, right] };
}

function conditionNodes(node) {
  if (!node) return [];
  if (node.type === "condition") return [node];
  if (node.type === "and" && node.children.every((child) => child.type === "condition")) return node.children;
  return [];
}

/**
 * Contextual Odoo-style search controls backed by the shared Query AST.
 *
 * The caller supplies the feature model and renders rows from onResults. The
 * user never chooses a data model here: a list view owns its model, while the
 * search language, filters, saved searches, and server-side scope remain
 * universal.
 */
export function createUniversalSearch(options) {
  const {
    root,
    apiFetch,
    model: modelName,
    organizationId,
    storeId,
    fields: requestedFields,
    pageSize = 80,
    placeholder,
    queryBasePath = "/api/v1/query",
    enableSavedQueries = true,
    enableSave = true,
    deferInitialLoad = false,
    onResults,
    onLoading,
    onError
  } = options;

  if (!root || typeof apiFetch !== "function" || typeof modelName !== "string") {
    throw new Error("Universal search requires a root, apiFetch, and model");
  }

  const endpoint = String(queryBasePath).replace(/\/$/u, "");

  const state = {
    model: null,
    filterRules: [],
    sortField: "",
    sortDirection: "asc",
    groupField: "",
    loadedSpec: null,
    savedQueries: [],
    requestId: 0,
    initialized: false,
    hasResults: false
  };

  function headers() {
    const organization = resolveValue(organizationId);
    return organization ? { "x-organization-id": organization } : {};
  }

  function requestedStore() {
    const value = resolveValue(storeId);
    return typeof value === "string" && value ? value : undefined;
  }

  function selectedFields() {
    const available = readableFields(state.model);
    const requested = Array.isArray(requestedFields) && requestedFields.length > 0
      ? requestedFields
      : available.slice(0, 8).map((field) => field.path);
    const selected = requested.filter((path) => available.some((field) => field.path === path));
    return selected.length > 0 ? selected : available.slice(0, 8).map((field) => field.path);
  }

  function defaultSort() {
    const sortable = sortableFields(state.model);
    const configured = state.model?.default_order?.find((order) => sortable.some((field) => field.path === order.field));
    return {
      field: configured?.field || sortable[0]?.path || "",
      direction: configured?.direction || "asc"
    };
  }

  function resetQueryState() {
    const defaultOrder = defaultSort();
    state.filterRules = [];
    state.sortField = defaultOrder.field;
    state.sortDirection = defaultOrder.direction;
    state.groupField = "";
    state.loadedSpec = null;
  }

  function filterAst() {
    const nodes = state.filterRules.flatMap((rule) => {
      const field = fieldByPath(state.model, rule.field);
      if (!field || !rule.operator) return [];
      const noValue = noValueOperators.has(rule.operator);
      if (!noValue && !String(rule.value || "").trim()) return [];
      let value = rule.value;
      if (["in", "not_in", "between"].includes(rule.operator)) {
        value = String(rule.value || "").split(",").map((item) => item.trim()).filter(Boolean);
      }
      return [{ type: "condition", field: field.path, operator: rule.operator, ...(noValue ? {} : { value }) }];
    });
    if (nodes.length === 0) return null;
    return nodes.length === 1 ? nodes[0] : { type: "and", children: nodes };
  }

  function querySpec() {
    if (state.loadedSpec && !root.querySelector("[data-query-input]").value.trim() && state.filterRules.length === 0) {
      return state.loadedSpec;
    }
    return {
      version: 1,
      model: state.model.technical_name,
      where: filterAst(),
      fields: selectedFields(),
      order_by: state.sortField ? [{ field: state.sortField, direction: state.sortDirection }] : [],
      group_by: state.groupField ? [state.groupField] : [],
      pagination: { limit: pageSize, offset: 0 }
    };
  }

  function setStatus(message, kind = "") {
    const node = root.querySelector("[data-query-status]");
    if (!node) return;
    node.textContent = message;
    node.className = `aevo-query-status${kind ? ` ${kind}` : ""}`;
  }

  function renderFilterValue(field, rule) {
    if (noValueOperators.has(rule.operator)) return `<span class="aevo-query-no-value">No value</span>`;
    return `<input type="${fieldInputType(field)}" data-query-filter-value aria-label="Filter value" placeholder="Value" value="${escapeHtml(rule.value || "")}" />`;
  }

  function renderFilters() {
    const list = root.querySelector("[data-query-filter-list]");
    const fields = filterableFields(state.model);
    if (!list) return;
    if (state.filterRules.length === 0) {
      list.innerHTML = `<div class="aevo-query-empty-filter">No filters yet. Search text is applied to the model's default search fields.</div>`;
      return;
    }
    list.innerHTML = state.filterRules.map((rule, index) => {
      const field = fieldByPath(state.model, rule.field) || fields[0];
      const operators = field?.operators || [];
      return `<div class="aevo-query-filter-row" data-query-filter-index="${index}">
        <select data-query-filter-field aria-label="Filter field">${fields.map((candidate) => `<option value="${escapeHtml(candidate.path)}" ${candidate.path === rule.field ? "selected" : ""}>${escapeHtml(candidate.label)}</option>`).join("")}</select>
        <select data-query-filter-operator aria-label="Filter operator">${operators.map((operator) => `<option value="${escapeHtml(operator)}" ${operator === rule.operator ? "selected" : ""}>${escapeHtml(operator.replaceAll("_", " "))}</option>`).join("")}</select>
        <div>${field ? renderFilterValue(field, rule) : ""}</div>
        <button class="aevo-query-remove" type="button" data-query-filter-remove aria-label="Remove filter">Remove</button>
      </div>`;
    }).join("");

    list.querySelectorAll("[data-query-filter-field]").forEach((node) => node.addEventListener("change", (event) => {
      const row = event.target.closest("[data-query-filter-index]");
      const index = Number(row?.dataset.queryFilterIndex);
      const field = fieldByPath(state.model, event.target.value) || fields[0];
      if (!field || !Number.isInteger(index)) return;
      state.loadedSpec = null;
      state.filterRules[index] = { field: field.path, operator: field.operators[0] || "eq", value: "" };
      renderFilters();
      updateFilterCount();
    }));
    list.querySelectorAll("[data-query-filter-operator]").forEach((node) => node.addEventListener("change", (event) => {
      const row = event.target.closest("[data-query-filter-index]");
      const index = Number(row?.dataset.queryFilterIndex);
      if (!Number.isInteger(index)) return;
      state.loadedSpec = null;
      state.filterRules[index].operator = event.target.value;
      renderFilters();
      updateFilterCount();
    }));
    list.querySelectorAll("[data-query-filter-value]").forEach((node) => node.addEventListener("input", (event) => {
      const row = event.target.closest("[data-query-filter-index]");
      const index = Number(row?.dataset.queryFilterIndex);
      if (!Number.isInteger(index)) return;
      state.loadedSpec = null;
      state.filterRules[index].value = event.target.value;
    }));
    list.querySelectorAll("[data-query-filter-remove]").forEach((node) => node.addEventListener("click", (event) => {
      const row = event.target.closest("[data-query-filter-index]");
      const index = Number(row?.dataset.queryFilterIndex);
      if (!Number.isInteger(index)) return;
      state.loadedSpec = null;
      state.filterRules.splice(index, 1);
      renderFilters();
      updateFilterCount();
    }));
  }

  function updateFilterCount() {
    const count = root.querySelector("[data-query-filter-count]");
    if (count) count.textContent = state.filterRules.length ? String(state.filterRules.length) : "";
    const clear = root.querySelector("[data-query-clear]");
    if (clear) clear.hidden = !root.querySelector("[data-query-input]").value.trim() && state.filterRules.length === 0;
  }

  function renderControls() {
    const sort = root.querySelector("[data-query-sort]");
    const direction = root.querySelector("[data-query-sort-direction]");
    const group = root.querySelector("[data-query-group]");
    const fields = filterableFields(state.model);
    const sortable = sortableFields(state.model);
    const groupable = groupableFields(state.model);
    if (sort) {
      sort.innerHTML = sortable.map((field) => `<option value="${escapeHtml(field.path)}">${escapeHtml(field.label)}</option>`).join("") || `<option value="">Default order</option>`;
      sort.value = state.sortField;
    }
    if (direction) direction.value = state.sortDirection;
    if (group) {
      group.innerHTML = `<option value="">No grouping</option>${groupable.map((field) => `<option value="${escapeHtml(field.path)}">${escapeHtml(field.label)}</option>`).join("")}`;
      group.value = state.groupField;
    }
    const add = root.querySelector("[data-query-add-filter]");
    if (add) add.disabled = fields.length === 0;
    renderFilters();
    updateFilterCount();
  }

  function setFilterPanel(open, focusSelector = "") {
    const panel = root.querySelector("[data-query-panel]");
    const filters = root.querySelector("[data-query-filters]");
    if (!panel || !filters) return;
    panel.hidden = !open;
    filters.setAttribute("aria-expanded", String(open));
    if (open && focusSelector) {
      root.querySelector(focusSelector)?.focus();
    }
  }

  function addFilter() {
    const fields = filterableFields(state.model);
    const field = fields.find((candidate) => candidate.capabilities?.search) || fields[0];
    if (!field) return;
    state.loadedSpec = null;
    state.filterRules.push({ field: field.path, operator: field.operators[0] || "eq", value: "" });
    renderFilters();
    updateFilterCount();
  }

  function clearSearch() {
    root.querySelector("[data-query-input]").value = "";
    resetQueryState();
    renderControls();
    void execute();
  }

  function fieldSearchDefinitions(trigger) {
    const query = String(trigger?.query || "").trim();
    if (!state.model || !query) return [];
    const modelLabel = state.model.label || "records";
    const fields = searchFields(state.model, requestedFields, query);
    return [
      {
        key: "all",
        label: "Search all fields for:",
        description: query,
        icon: "search",
        fieldSearchMode: "all",
        searchTail: "Default",
        keywords: ["default", "all", modelLabel]
      },
      ...fields.map((field) => {
        const operator = searchOperatorForField(field, query);
        const label = searchFieldLabel(state.model, field);
        const identifierField = isIdentifierField(field);
        const identifierReady = !identifierField || isIdentifierQuery(query);
        return {
          key: field.path,
          label: `Search ${label} for:`,
          description: identifierReady ? query : `${query} · enter a complete ID`,
          icon: "search",
          fieldPath: field.path,
          fieldSearchMode: "field",
          fieldSearchOperator: operator,
          disabled: !identifierReady,
          searchTail: field.path,
          keywords: ["field", "header", label, field.path]
        };
      }),
      {
        key: "custom-filter",
        label: "Custom filter",
        description: "Open field, operator, sort, and group controls",
        icon: "filter",
        fieldSearchAction: "advanced",
        searchTail: "Filters",
        keywords: ["advanced", "filter", "builder"]
      }
    ];
  }

  function commandDefinitions() {
    const operatorLabels = {
      contains: "contains",
      not_contains: "does not contain",
      starts_with: "starts with",
      ends_with: "ends with",
      eq: "equals",
      neq: "does not equal",
      gt: "greater than",
      gte: "at least",
      lt: "less than",
      lte: "at most",
      in: "is one of",
      not_in: "is not one of",
      between: "is between",
      is_empty: "is empty",
      is_not_empty: "is not empty",
      before: "before",
      after: "after",
      on: "on",
      today: "today",
      yesterday: "yesterday",
      this_week: "this week",
      this_month: "this month"
    };
    const operatorDescription = (operator) => {
      if (noValueOperators.has(operator)) return `Match ${operatorLabels[operator]}`;
      if (operator === "in" || operator === "not_in") return `${operatorLabels[operator]} (comma-separated values)`;
      if (operator === "between") return "Match a comma-separated range with two values";
      return `Match a value that ${operatorLabels[operator]}`;
    };
    const commands = [
      { key: "help", label: "Search command help", description: "Show logical, field, filter, sort, and group commands", icon: "help", keywords: ["command", "menu", "search"] },
      { key: "and", label: "AND", description: "Match all terms — item AND test", icon: "logic", insert: "AND ", keywords: ["all", "every", "boolean"] },
      { key: "or", label: "OR", description: "Match any term — item OR test", icon: "logic", insert: "OR ", keywords: ["any", "either", "boolean"] },
      { key: "not", label: "NOT", description: "Exclude the next term — item NOT test", icon: "logic", insert: "NOT ", keywords: ["exclude", "without", "boolean"] },
      { key: "open-group", label: "Open group", description: "Start a grouped OR/AND expression", icon: "group", insert: "( ", keywords: ["parentheses", "expression"] },
      { key: "close-group", label: "Close group", description: "Close the current grouped expression", icon: "group", insert: " )", keywords: ["parentheses", "expression"] },
      { key: "advanced", label: "Open advanced controls", description: "Open the visual filter, sort, and group builder", icon: "filter", keywords: ["filters", "panel", "builder"] },
      { key: "filters", label: "Open advanced controls", description: "Open the visual filter, sort, and group builder", icon: "filter", keywords: ["advanced", "panel", "builder"] },
      { key: "add-filter", label: "Add visual filter", description: "Add a filter row to the visual builder", icon: "plus", keywords: ["filter", "condition", "builder"] },
      { key: "refresh", label: "Refresh results", description: "Run the current query again", icon: "refresh", keywords: ["reload"] },
      { key: "clear", label: "Clear search", description: "Reset text, filters, sort, and grouping", icon: "clear", keywords: ["reset"] }
    ];

    const filterCommands = filterableFields(state.model).flatMap((field) => {
      const fieldCommands = [];
      const operators = Array.isArray(field.operators) ? field.operators : [];
      if (operators.includes("contains")) {
        fieldCommands.push({
          key: `field:${field.path}`,
          label: `Filter by ${field.label}`,
          description: `Search ${field.path}:value (${operatorLabels.contains})`,
          icon: "filter",
          insert: `${field.path}:`,
          keywords: ["field", "filter", field.path, "contains"]
        });
      }
      for (const operator of operators) {
        if (operator === "contains") continue;
        fieldCommands.push({
          key: `filter:${field.path}:${operator}`,
          label: `${field.label} · ${operatorLabels[operator] || operator.replaceAll("_", " ")}`,
          description: `${field.path}:${operator}:value — ${operatorDescription(operator)}`,
          icon: "filter",
          insert: noValueOperators.has(operator) ? `${field.path}:${operator}` : `${field.path}:${operator}:`,
          executeAfterInsert: noValueOperators.has(operator),
          keywords: ["field", "filter", field.path, operator]
        });
      }
      return fieldCommands;
    });

    const sortCommands = [
      { key: "sort:reset", label: "Reset sorting", description: "Return to the model's default order", icon: "sort", sortField: defaultSort().field, sortDirection: defaultSort().direction, keywords: ["order", "default"] },
      ...sortableFields(state.model).flatMap((field) => [
        { key: `sort:${field.path}:asc`, label: `Sort by ${field.label} · ascending`, description: `Order results by ${field.path} from low to high`, icon: "sort", sortField: field.path, sortDirection: "asc", keywords: ["sort", "order", field.path, "ascending"] },
        { key: `sort:${field.path}:desc`, label: `Sort by ${field.label} · descending`, description: `Order results by ${field.path} from high to low`, icon: "sort", sortField: field.path, sortDirection: "desc", keywords: ["sort", "order", field.path, "descending"] }
      ])
    ];

    const groupCommands = [
      { key: "group:reset", label: "Clear grouping", description: "Show a flat result list", icon: "group", groupField: "", keywords: ["group", "ungroup"] },
      ...groupableFields(state.model).map((field) => ({
        key: `group:${field.path}`,
        label: `Group by ${field.label}`,
        description: `Group results by ${field.path}`,
        icon: "group",
        groupField: field.path,
        keywords: ["group", "aggregate", field.path]
      }))
    ];
    commands.push(...filterCommands, ...sortCommands, ...groupCommands);
    if (enableSavedQueries) {
      commands.push({ key: "saved", label: "Saved searches", description: "Jump to a saved search", icon: "saved", keywords: ["views", "favorites"] });
    }
    if (enableSave) {
      commands.push({ key: "save", label: "Save search", description: "Save the current query for later", icon: "save", keywords: ["view"] });
    }
    return commands;
  }

  function runCommand(command, context) {
    if (Object.prototype.hasOwnProperty.call(command, "sortField")) {
      state.loadedSpec = null;
      state.sortField = command.sortField;
      state.sortDirection = command.sortDirection;
      renderControls();
      void execute();
      return;
    }
    if (Object.prototype.hasOwnProperty.call(command, "groupField")) {
      state.loadedSpec = null;
      state.groupField = command.groupField;
      renderControls();
      void execute();
      return;
    }
    if (command.executeAfterInsert) {
      void execute();
      return;
    }
    switch (command.key) {
      case "help":
        context.reopen();
        return;
      case "advanced":
      case "filters":
        setFilterPanel(true);
        return;
      case "add-filter":
        setFilterPanel(true);
        addFilter();
        return;
      case "saved":
        root.querySelector("[data-query-saved]")?.focus();
        return;
      case "save":
        void saveSearch();
        return;
      case "refresh":
        void execute();
        return;
      case "clear":
        clearSearch();
        return;
      default:
        return;
    }
  }

  function runFieldSearch(command, context) {
    if (command.fieldSearchAction === "advanced") {
      context.close();
      setFilterPanel(true);
      return;
    }
    void execute();
  }

  function requestSaveName() {
    const dialog = root.querySelector("[data-query-save-dialog]");
    const input = root.querySelector("[data-query-save-name]");
    if (!dialog || !input) return Promise.resolve(null);

    return new Promise((resolve) => {
      const status = root.querySelector("[data-query-save-status]");
      const closeButtons = root.querySelectorAll("[data-query-save-dialog-close]");
      const confirmButton = root.querySelector("[data-query-save-confirm]");
      let settled = false;

      const cleanup = () => {
        dialog.removeEventListener("close", handleClose);
        closeButtons.forEach((button) => button.removeEventListener("click", handleCancel));
        confirmButton?.removeEventListener("click", handleConfirm);
        input.removeEventListener("input", handleInput);
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const handleClose = () => finish(null);
      const handleCancel = () => finish(null);
      const handleInput = () => {
        input.removeAttribute("aria-invalid");
        if (status) status.hidden = true;
      };
      const handleConfirm = () => {
        const value = input.value.trim();
        if (!value) {
          input.setAttribute("aria-invalid", "true");
          if (status) status.hidden = false;
          input.focus();
          return;
        }
        finish(value);
      };

      input.value = "";
      input.removeAttribute("aria-invalid");
      if (status) status.hidden = true;
      dialog.addEventListener("close", handleClose);
      closeButtons.forEach((button) => button.addEventListener("click", handleCancel));
      confirmButton?.addEventListener("click", handleConfirm);
      input.addEventListener("input", handleInput);
      dialog.showModal();
      input.focus();
    });
  }

  async function loadSavedQueries() {
    const select = root.querySelector("[data-query-saved]");
    if (!select || !enableSavedQueries) return;
    try {
      const result = await apiFetch(`${endpoint}/saved?model=${encodeURIComponent(state.model.technical_name)}`, { headers: headers() });
      state.savedQueries = Array.isArray(result?.savedQueries) ? result.savedQueries : [];
      select.innerHTML = `<option value="">Saved searches</option>${state.savedQueries.map((saved) => `<option value="${escapeHtml(saved.id)}">${escapeHtml(saved.name)} · ${escapeHtml(saved.scope)}</option>`).join("")}`;
    } catch {
      state.savedQueries = [];
      select.innerHTML = `<option value="">Saved searches unavailable</option>`;
    }
  }

  function loadSavedQuery(saved) {
    const input = root.querySelector("[data-query-input]");
    state.loadedSpec = saved.query;
    state.filterRules = conditionNodes(saved.query?.where).map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      value: Array.isArray(condition.value) ? condition.value.join(", ") : condition.value ?? ""
    }));
    state.sortField = saved.query?.order_by?.[0]?.field || defaultSort().field;
    state.sortDirection = saved.query?.order_by?.[0]?.direction || defaultSort().direction;
    state.groupField = saved.query?.group_by?.[0] || "";
    input.value = "";
    renderControls();
    void execute();
  }

  async function saveSearch() {
    const query = querySpec();
    const searchText = root.querySelector("[data-query-input]").value.trim();
    if (searchText) {
      try {
        const parsed = await apiFetch(`${endpoint}/parse`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ searchText })
        });
        query.where = combineWhere(query.where, parsed?.where || null);
      } catch (error) {
        setStatus(error.message || "Search expression is invalid", "error");
        return;
      }
    }
    const name = await requestSaveName();
    if (!name?.trim()) return;
    try {
      await apiFetch(`${endpoint}/saved`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: name.trim(), scope: "PRIVATE", query, ...(requestedStore() ? { storeId: requestedStore() } : {}) })
      });
      setStatus("Search saved");
      await loadSavedQueries();
    } catch (error) {
      setStatus(error.message || "Could not save this search", "error");
    }
  }

  async function execute() {
    if (!state.model) return;
    const requestId = ++state.requestId;
    const input = root.querySelector("[data-query-input]");
    if (!input) return;
    const searchText = input.value.trim();
    setStatus("Searching…");
    const submit = root.querySelector("[data-query-submit]");
    root.classList.add("is-loading");
    root.dataset.loading = "true";
    if (submit) {
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
    }
    root.setAttribute("aria-busy", "true");
    try {
      onLoading?.({ initial: !state.hasResults, model: state.model });
      const result = await apiFetch(`${endpoint}/execute`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          query: querySpec(),
          ...(searchText ? { searchText } : {}),
          ...(requestedStore() ? { storeId: requestedStore() } : {})
        })
      });
      if (requestId !== state.requestId) return;
      const total = Number(result?.total || 0);
      setStatus(`${total.toLocaleString()} record${total === 1 ? "" : "s"}`);
      updateFilterCount();
      state.hasResults = true;
      await onResults?.(result, { model: state.model, spec: result?.query || querySpec() });
    } catch (error) {
      if (requestId !== state.requestId) return;
      setStatus(error.message || "Search failed", "error");
      await onError?.(error);
    } finally {
      if (requestId !== state.requestId) return;
      if (submit) {
        submit.disabled = false;
        submit.removeAttribute("aria-busy");
      }
      root.classList.remove("is-loading");
      delete root.dataset.loading;
      root.setAttribute("aria-busy", "false");
    }
  }

  function renderLoadingShell() {
    const label = root.dataset.queryLabel || "records";
    root.classList.add("aevo-query-search", "is-loading");
    root.classList.remove("is-error");
    root.innerHTML = `<div class="aevo-query-loading" role="status" aria-live="polite" aria-label="Loading ${escapeHtml(label)} search">
      <div class="aevo-query-loading-row">
        <span class="aevo-spinner" aria-hidden="true"></span>
        <span class="aevo-skeleton aevo-query-loading-input" aria-hidden="true"></span>
        <span class="aevo-skeleton aevo-query-loading-button" aria-hidden="true"></span>
      </div>
      <span class="aevo-skeleton aevo-query-loading-hint" aria-hidden="true"></span>
      <span>Loading search controls…</span>
    </div>`;
  }

  function renderShell() {
    const label = root.dataset.queryLabel || state.model?.label || "records";
    const hint = root.dataset.queryHint || `Search ${label.toLowerCase()} by name, code, status, or field expression.`;
    const saveDialogTitleId = `aevo-query-save-title-${++searchInstanceSequence}`;
    root.classList.add("aevo-query-search");
    root.classList.remove("is-loading", "is-error");
    root.innerHTML = `<div class="aevo-query-search-row">
      <div class="aevo-query-input-wrap">
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
        <input type="search" data-query-input autocomplete="off" placeholder="${escapeHtml(placeholder || `Search ${label.toLowerCase()}…`)}" aria-label="Search ${escapeHtml(label)}" />
        <kbd>Enter</kbd>
      </div>
      <button class="aevo-query-primary" type="button" data-query-submit><span class="aevo-button-spinner" aria-hidden="true"></span><span data-query-submit-label>Search</span></button>
      <button class="aevo-query-secondary" type="button" data-query-filters aria-expanded="false">Filters <span data-query-filter-count></span></button>
      ${enableSavedQueries ? '<select class="aevo-query-saved" data-query-saved aria-label="Saved searches"><option value="">Saved searches</option></select>' : ""}
      ${enableSave ? '<button class="aevo-query-secondary" type="button" data-query-save>Save</button>' : ""}
      <button class="aevo-query-clear" type="button" data-query-clear hidden>Clear</button>
    </div>
    <div class="aevo-query-hint">${escapeHtml(hint)} <span>Type a term to choose a field, combine it with <code>/</code> commands such as <code>test /and se</code>, or use <code>field:value</code> and <code>field:operator:value</code>.</span></div>
    <div class="aevo-query-panel" data-query-panel hidden>
      <div class="aevo-query-panel-head"><div><strong>Advanced search</strong><span>These controls produce the same validated Query AST as the search bar.</span></div><button class="aevo-query-close" type="button" data-query-close>Done</button></div>
      <div class="aevo-query-filter-list" data-query-filter-list></div>
      <button class="aevo-query-add-filter" type="button" data-query-add-filter>+ Add filter</button>
      <div class="aevo-query-options">
        <label>Sort by<select data-query-sort></select></label>
        <label>Direction<select data-query-sort-direction><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
        <label>Group by<select data-query-group><option value="">No grouping</option></select></label>
      </div>
    </div>
    <div class="aevo-query-footer"><span data-query-status role="status" aria-live="polite">Ready</span><span>Server-scoped search</span></div>
    <dialog class="aevo-query-save-dialog" data-query-save-dialog aria-labelledby="${saveDialogTitleId}">
      <div class="modal-header">
        <div><div class="modal-header-title" id="${saveDialogTitleId}">Save search</div><div class="modal-header-subtitle">Keep this validated query available for the next session.</div></div>
        <button class="modal-close-btn" type="button" data-query-save-dialog-close aria-label="Close">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"></path></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="input-field-group"><label for="aevo-query-save-name">Search name</label><input id="aevo-query-save-name" data-query-save-name autocomplete="off" maxlength="80" placeholder="e.g. Active stores" /></div>
        <p class="aevo-query-save-status" data-query-save-status role="status" hidden>Enter a name to save this search.</p>
      </div>
      <div class="modal-footer"><button class="pill-btn pill-btn-ghost" type="button" data-query-save-dialog-close>Cancel</button><button class="pill-btn pill-btn-primary" type="button" data-query-save-confirm>Save search</button></div>
    </dialog>`;

    const input = root.querySelector("[data-query-input]");
    createSlashCommandMenu({
      input,
      anchor: input.closest(".aevo-query-input-wrap"),
      getTrigger: (value) => {
        const slash = parseSlashToken(value);
        return slash ? { ...slash, kind: "command" } : parseFieldSearchTrigger(value);
      },
      getCommands: (trigger) => trigger?.kind === "field" ? fieldSearchDefinitions(trigger) : commandDefinitions(),
      getFilter: (trigger) => trigger?.kind === "field" ? "" : trigger?.query || "",
      menuTitle: (trigger) => trigger?.kind === "field" ? "Search in fields" : "Commands",
      menuHint: (trigger) => trigger?.kind === "field"
        ? "Choose a list field · Tab to use · Enter to search · Esc to close"
        : "Tab to use · Enter to run · Esc to close",
      replaceValue: (value, trigger, command) => {
        if (trigger?.kind === "field") {
          if (command.fieldSearchAction === "advanced") return String(value).trim();
          const query = String(value).trim();
          if (command.fieldSearchMode === "all") return query;
          if (!command.fieldPath || !query) return query;
          const operator = command.fieldSearchOperator && command.fieldSearchOperator !== "contains"
            ? `:${command.fieldSearchOperator}`
            : "";
          return `${command.fieldPath}${operator}:${quoteQueryText(query)}`;
        }
        const before = value.slice(0, trigger?.start || 0);
        const after = value.slice(trigger?.end || value.length);
        const insert = command.insert || "";
        const separator = insert && before && !/\s$/u.test(before) && !/^\s/u.test(insert) ? " " : "";
        return `${before}${separator}${insert}${after}`;
      },
      getCaret: (replacement, trigger, command) => {
        if (trigger?.kind === "field" && command.fieldSearchMode === "field" && replacement.endsWith('"')) {
          return replacement.length - 1;
        }
        if (trigger?.kind === "command" && trigger.closingQuote && replacement.endsWith(trigger.closingQuote)) {
          return replacement.length - trigger.closingQuote.length;
        }
        return replacement.length;
      },
      renderTail: (command) => command.searchTail || `/${command.key}`,
      onSelect: (command, context) => context.parsed?.kind === "field"
        ? runFieldSearch(command, context)
        : runCommand(command, context)
    });

    root.querySelector("[data-query-submit]").addEventListener("click", () => void execute());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void execute();
    });
    input.addEventListener("input", updateFilterCount);
    root.querySelector("[data-query-filters]").addEventListener("click", (event) => {
      const panel = root.querySelector("[data-query-panel]");
      setFilterPanel(Boolean(panel?.hidden));
    });
    root.querySelector("[data-query-close]").addEventListener("click", () => setFilterPanel(false));
    root.querySelector("[data-query-add-filter]").addEventListener("click", addFilter);
    root.querySelector("[data-query-sort]").addEventListener("change", (event) => { state.loadedSpec = null; state.sortField = event.target.value; });
    root.querySelector("[data-query-sort-direction]").addEventListener("change", (event) => { state.loadedSpec = null; state.sortDirection = event.target.value; });
    root.querySelector("[data-query-group]").addEventListener("change", (event) => { state.loadedSpec = null; state.groupField = event.target.value; });
    root.querySelector("[data-query-clear]").addEventListener("click", clearSearch);
    if (enableSave) root.querySelector("[data-query-save]")?.addEventListener("click", () => void saveSearch());
    if (enableSavedQueries) root.querySelector("[data-query-saved]")?.addEventListener("change", (event) => {
      const saved = state.savedQueries.find((item) => item.id === event.target.value);
      if (saved) loadSavedQuery(saved);
    });
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;
    root.setAttribute("aria-busy", "true");
    renderLoadingShell();
    try {
      const modelCacheKey = `${endpoint}:${modelName}`;
      let model = modelCache.get(modelCacheKey);
      if (!model) {
        let models = modelListCache.get(endpoint);
        if (!models) {
          let pending = modelListPromises.get(endpoint);
          if (!pending) {
            pending = apiFetch(`${endpoint}/models`, { headers: headers() })
              .then((result) => Array.isArray(result?.models) ? result.models : [])
              .finally(() => modelListPromises.delete(endpoint));
            modelListPromises.set(endpoint, pending);
          }
          models = await pending;
          modelListCache.set(endpoint, models);
        }
        model = models.find((candidate) => candidate.technical_name === modelName);
        if (model) modelCache.set(modelCacheKey, model);
      }
      if (!model) throw new Error(`Query model '${modelName}' is unavailable`);
      state.model = model;
      renderShell();
      resetQueryState();
      renderControls();
      const savedQueriesPromise = enableSavedQueries ? loadSavedQueries() : Promise.resolve();
      if (deferInitialLoad) {
        // The surrounding page already has a server-provided fallback list.
        // Metadata and saved searches can warm in the background; the first
        // query is user initiated so hidden widgets never duplicate the page
        // read that produced the visible rows.
        void savedQueriesPromise;
        setStatus("Ready");
      } else {
        await Promise.all([savedQueriesPromise, execute()]);
      }
    } catch (error) {
      state.initialized = false;
      root.classList.remove("is-loading");
      root.classList.add("is-error");
      root.innerHTML = `<div class="aevo-loading-state aevo-loading-state--error" role="alert">
        <strong>Search is temporarily unavailable.</strong>
        <span>${escapeHtml(error.message || "Universal search is unavailable")}</span>
        <button type="button" data-query-retry>Try again</button>
      </div>`;
      root.querySelector("[data-query-retry]")?.addEventListener("click", () => void init());
      await onError?.(error);
    } finally {
      root.setAttribute("aria-busy", "false");
    }
  }

  async function refresh() {
    if (!state.model) {
      await init();
      return;
    }
    return execute();
  }

  return {
    init,
    refresh,
    setContext: refresh,
    getQuery: querySpec
  };
}
