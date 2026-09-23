// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PluginActionAuditLogViewer } from "../PluginActionAuditLogViewer";
import { PLUGIN_AUDIT_SCHEMA_VERSION, type PluginActionAuditRecord } from "@shared/types";

function record(overrides: Partial<PluginActionAuditRecord> = {}): PluginActionAuditRecord {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    ts: 1_000,
    pluginId: "acme.plugin",
    actionId: "acme.plugin.doThing",
    argsHash: "a".repeat(64),
    durationMs: 5,
    result: "error",
    schemaVersion: PLUGIN_AUDIT_SCHEMA_VERSION,
    ...overrides,
  };
}

function renderViewer(records: PluginActionAuditRecord[]) {
  return render(
    <PluginActionAuditLogViewer
      records={records}
      loading={false}
      maxRecords={500}
      onRefresh={vi.fn()}
      onCopy={vi.fn()}
      onExport={vi.fn()}
      onClear={vi.fn()}
    />
  );
}

describe("PluginActionAuditLogViewer", () => {
  it("renders the errorMessage of a failure record so failures are inspectable", () => {
    renderViewer([
      record({ result: "error", errorMessage: "plugin handler exploded at boundary" }),
    ]);
    expect(screen.getByText("plugin handler exploded at boundary")).toBeTruthy();
  });

  it("omits the error line when a record carries no errorMessage", () => {
    renderViewer([record({ result: "restricted", errorMessage: undefined })]);
    expect(screen.queryByText(/exploded/)).toBeNull();
  });

  it("tags an ipc-invoke record with its record type instead of an empty source", () => {
    renderViewer([
      record({
        recordType: "ipc-invoke",
        channel: "plugin:invoke",
        result: "error",
        errorMessage: "untrusted sender",
      }),
    ]);
    // ipc-invoke records have no `source`; the record-type tag stands in for it.
    expect(screen.getByText("IPC")).toBeTruthy();
  });

  it("shows the dispatch source for an action-dispatch record", () => {
    // `success` rows are hidden by default, so use an `error` action-dispatch
    // record (kept visible by the default failure-centric view) to assert the
    // source label still renders.
    renderViewer([
      record({ recordType: "action-dispatch", source: "keybinding", result: "error" }),
    ]);
    expect(screen.getByText("keybinding")).toBeTruthy();
  });

  it("makes errorMessage searchable", () => {
    renderViewer([
      record({ id: "match", result: "error", errorMessage: "needle-in-haystack" }),
      record({
        id: "other",
        result: "error",
        errorMessage: "unrelated failure",
        actionId: "acme.plugin.other",
      }),
    ]);
    const search = screen.getByLabelText("Search audit arguments or error messages");
    fireEvent.change(search, { target: { value: "needle" } });
    expect(screen.getByText("needle-in-haystack")).toBeTruthy();
    expect(screen.queryByText("unrelated failure")).toBeNull();
  });

  it("renders a record with neither recordType nor source without leaking 'undefined'", () => {
    renderViewer([
      record({ recordType: undefined, source: undefined, result: "error", actionId: "acme.bare" }),
    ]);
    // The row still renders its identifying fields...
    expect(screen.getByText("acme.bare")).toBeTruthy();
    // ...and never stringifies an absent source/recordType into the DOM.
    expect(screen.queryByText("undefined")).toBeNull();
  });

  it("hides success rows by default but reveals them via the result filter", () => {
    renderViewer([
      record({ id: "ok", result: "success", actionId: "acme.plugin.win" }),
      record({ id: "bad", result: "error", actionId: "acme.plugin.lose" }),
    ]);
    // Default failure-centric view: the success row is suppressed.
    expect(screen.queryByText("acme.plugin.win")).toBeNull();
    expect(screen.getByText("acme.plugin.lose")).toBeTruthy();
    // Explicitly filtering to "success" overrides the suppression.
    fireEvent.change(screen.getByLabelText("Filter audit by result"), {
      target: { value: "success" },
    });
    expect(screen.getByText("acme.plugin.win")).toBeTruthy();
  });

  it("means every record when the result filter says All results", () => {
    renderViewer([
      record({ id: "ok", result: "success", actionId: "acme.plugin.win" }),
      record({ id: "bad", result: "error", actionId: "acme.plugin.lose" }),
    ]);
    const filter = screen.getByLabelText("Filter audit by result") as HTMLSelectElement;
    // The narrower default is a named choice, not a hidden rule.
    expect(filter.selectedOptions[0]?.textContent).toBe("Problems");
    fireEvent.change(filter, { target: { value: "all" } });
    expect(screen.getByText("acme.plugin.win")).toBeTruthy();
    expect(screen.getByText("acme.plugin.lose")).toBeTruthy();
  });

  it("offers a way out of a filter that matches nothing", () => {
    renderViewer([record({ id: "bad", actionId: "acme.plugin.lose" })]);
    fireEvent.change(screen.getByLabelText("Filter audit by plugin or action ID"), {
      target: { value: "no-such-plugin" },
    });
    expect(screen.queryByText("acme.plugin.lose")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("acme.plugin.lose")).toBeTruthy();
  });
});
