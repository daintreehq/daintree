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
});
