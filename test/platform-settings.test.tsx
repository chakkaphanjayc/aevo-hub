import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilityNotice } from "../apps/hub/app/components/platform-settings";
import { paginate, parseStructuredListQuery, queryWithPage } from "../apps/hub/app/lib/structured-list";
import { unexposedCapabilities } from "../apps/hub/app/lib/platform-capabilities.server";

describe("Hub platform settings contracts", () => {
  test("parses URL-backed list controls and drops unsupported columns and sorts", () => {
    const query = parseStructuredListQuery(new URLSearchParams("q=%20sam%20&sort=secret&page=-2&pageSize=15&columns=member&columns=unknown"), {
      columns: ["member", "role"],
      defaultColumns: ["member", "role"],
      sorts: ["name", "email"],
      pageSizes: [10, 25, 50],
    });

    expect(query).toEqual({
      q: "sam",
      role: "",
      status: "",
      scope: "",
      sort: "name",
      direction: "asc",
      page: 1,
      pageSize: 10,
      columns: ["member"],
    });
  });

  test("paginates safely and retains current query state when moving pages", () => {
    const page = paginate(["one", "two", "three"], 8, 2);
    expect(page.items).toEqual(["three"]);
    expect(page.page).toBe(2);
    expect(page.pageCount).toBe(2);
    expect(queryWithPage(new URLSearchParams("q=maya&role=ADMIN"), 2)).toBe("?q=maya&role=ADMIN&page=2");
  });

  test("renders a semantic unavailable state with the Core capability code", () => {
    const html = renderToStaticMarkup(createElement(CapabilityNotice, {
      state: "unavailable",
      title: "Reports unavailable",
      description: unexposedCapabilities.queryPlatform.message,
      code: unexposedCapabilities.queryPlatform.code,
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain("CORE_QUERY_PLATFORM_NOT_EXPOSED");
    expect(html).toContain("Core does not expose Query Platform");
  });
});
