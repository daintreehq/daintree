// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ForgeAuditLogViewer } from "../ForgeAuditLogViewer";
import type { ForgeAuditRecord } from "@shared/types/ipc/forge";

function record(id: string, methodName: string, result: ForgeAuditRecord["result"]) {
  return {
    id,
    timestamp: Date.now(),
    providerId: "github",
    methodName,
    argsSummary: "{}",
    result,
    durationMs: 5,
  } as ForgeAuditRecord;
}

function renderViewer(records: ForgeAuditRecord[]) {
  return render(
    <ForgeAuditLogViewer
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

describe("ForgeAuditLogViewer", () => {
  it("names its problems-first default and lets All results mean all", () => {
    renderViewer([record("1", "listIssues", "success"), record("2", "getIssue", "error")]);
    const filter = screen.getByLabelText("Filter audit by result") as HTMLSelectElement;
    expect(filter.selectedOptions[0]?.textContent).toBe("Problems");
    expect(screen.queryByText("listIssues")).toBeNull();
    fireEvent.change(filter, { target: { value: "all" } });
    expect(screen.getByText("listIssues")).toBeTruthy();
    expect(screen.getByText("getIssue")).toBeTruthy();
  });

  it("offers a way out of a filter that matches nothing", () => {
    renderViewer([record("2", "getIssue", "error")]);
    fireEvent.change(screen.getByLabelText("Filter audit by method or provider"), {
      target: { value: "nothing-matches" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("getIssue")).toBeTruthy();
  });
});
