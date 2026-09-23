import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Combobox, PermissionDeniedState, StatusBadge } from "../src";

describe("@aevocado/design-system primitives", () => {
  it("exposes an accessible pending button state", () => {
    const markup = renderToStaticMarkup(<Button busy busyLabel="Saving…">Save</Button>);
    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Saving…");
    expect(markup).not.toContain(">Save</span>");
  });

  it("supports status badges without forcing a decorative dot", () => {
    const markup = renderToStaticMarkup(<StatusBadge tone="info" dot={false}>Assigned</StatusBadge>);
    expect(markup).toContain("aevo-status--info");
    expect(markup).toContain("aevo-status--no-dot");
  });

  it("uses an alert role for permission-denied recovery states", () => {
    const markup = renderToStaticMarkup(
      <PermissionDeniedState
        title="Settings are restricted"
        description="Ask an organization manager for access."
      />
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("aevo-state--denied");
  });

  it("renders a keyboard-addressable combobox contract", () => {
    const markup = renderToStaticMarkup(
      <Combobox
        id="organization"
        aria-label="Organization"
        options={[{ value: "sports", label: "Aevo Sports" }]}
      />
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-autocomplete="list"');
    expect(markup).toContain('aria-controls="organization-listbox"');
  });
});
