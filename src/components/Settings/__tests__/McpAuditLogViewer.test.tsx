// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpAuditLogViewer } from "../McpAuditLogViewer";
import type { AssistantTurnRecord, McpLogRecord } from "@shared/types";

function dispatch(id: string, toolId: string, result = "success"): McpLogRecord {
  return {
    id,
    timestamp: Date.now(),
    toolId,
    sessionId: "s",
    tier: "external",
    argsSummary: "{}",
    result,
    durationMs: 3,
  } as McpLogRecord;
}

function renderViewer(records: McpLogRecord[], turnRecords?: AssistantTurnRecord[]) {
  return render(
    <McpAuditLogViewer
      records={records}
      turnRecords={turnRecords}
      loading={false}
      onRefresh={vi.fn()}
      onCopy={vi.fn()}
      onClear={vi.fn()}
      maxRecords={500}
    />
  );
}

describe("McpAuditLogViewer", () => {
  it("offers a way out of a filter that matches nothing", () => {
    renderViewer([dispatch("1", "worktree.list")]);
    fireEvent.change(screen.getByLabelText("Filter audit by tool name"), {
      target: { value: "no-such-tool" },
    });
    expect(screen.queryByText("worktree.list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("worktree.list")).toBeTruthy();
  });

  it("tells a deliberately cleared log apart from one that never had records", () => {
    const { rerender } = renderViewer([]);
    const firstUse = document.body.textContent;
    rerender(
      <McpAuditLogViewer
        records={[]}
        loading={false}
        onRefresh={vi.fn()}
        onCopy={vi.fn()}
        onClear={vi.fn()}
        emptyLabel="Audit log cleared"
      />
    );
    expect(document.body.textContent).not.toBe(firstUse);
    expect(screen.getByText("Audit log cleared")).toBeTruthy();
  });

  it("exposes the group-by-turn view as a pressed toggle", () => {
    renderViewer([dispatch("1", "worktree.list")], [
      { id: "t", timestamp: Date.now(), terminalId: null, sessionId: null, outcome: "answered" },
    ]);
    const toggle = screen.getByRole("button", { name: "Group by turn" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the count and copy feedback in a polite live region", () => {
    const { rerender } = renderViewer([dispatch("1", "worktree.list")]);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("1 of 500");
    rerender(
      <McpAuditLogViewer
        records={[dispatch("1", "worktree.list")]}
        loading={false}
        onRefresh={vi.fn()}
        onCopy={vi.fn()}
        maxRecords={500}
        copyFlashActive
      />
    );
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Copied!");
  });
});
