// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
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
    renderViewer(
      [dispatch("1", "worktree.list")],
      [{ id: "t", timestamp: Date.now(), terminalId: null, sessionId: null, outcome: "answered" }]
    );
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

  it("narrows to every unsuccessful call under Problems", () => {
    renderViewer([
      dispatch("1", "worktree.list"),
      dispatch("2", "git.getDiff", "error"),
      dispatch("3", "project.getSettings", "rate_limited"),
    ]);
    fireEvent.change(screen.getByLabelText("Filter audit by result"), {
      target: { value: "problems" },
    });
    expect(screen.queryByText("worktree.list")).toBeNull();
    expect(screen.getByText("git.getDiff")).toBeTruthy();
    expect(screen.getByText("project.getSettings")).toBeTruthy();
  });

  it("names an unsuccessful outcome in words beside the tool", () => {
    renderViewer([dispatch("3", "project.getSettings", "rate_limited")]);
    // The glyph alone can't tell rate limited from awaiting confirmation or a collision.
    expect(within(screen.getByRole("list")).getByText(/Rate limited/)).toBeTruthy();
  });

  it("keeps a grant as context only for a session with a matching call", () => {
    const grant = (id: string, sessionId: string, toolId: string) =>
      ({
        type: "grant.issued",
        id,
        timestamp: Date.now(),
        sessionId,
        toolId,
        ttlMs: 60_000,
      }) as McpLogRecord;
    const call = (id: string, sessionId: string, toolId: string, result: string) =>
      ({ ...dispatch(id, toolId, result), sessionId }) as McpLogRecord;
    renderViewer([
      call("1", "s-a", "terminal.sendKeys", "unauthorized"),
      grant("g-a", "s-a", "grant.for.session.a"),
      grant("g-b", "s-b", "grant.for.session.b"),
    ]);
    fireEvent.change(screen.getByLabelText("Filter audit by result"), {
      target: { value: "unauthorized" },
    });
    expect(screen.getByText("grant.for.session.a")).toBeTruthy();
    expect(screen.queryByText("grant.for.session.b")).toBeNull();

    // An unrelated grant can't hold up a result that matches no call.
    fireEvent.change(screen.getByLabelText("Filter audit by result"), {
      target: { value: "error" },
    });
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });
});
