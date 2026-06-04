// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpAuditRecord } from "@shared/types";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

// Deterministic popover: mirrors the controlled open/onOpenChange contract so
// tests drive the strip's own state machine without Radix's async chunk load.
vi.mock("@/components/ui/popover", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{ open?: boolean; onOpenChange?: (v: boolean) => void }>({});
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: React.PropsWithChildren<{ open?: boolean; onOpenChange?: (v: boolean) => void }>) =>
      React.createElement(Ctx.Provider, { value: { open, onOpenChange } }, children),
    PopoverTrigger: ({ children }: { children: React.ReactElement; asChild?: boolean }) => {
      const { open, onOpenChange } = React.useContext(Ctx);
      return React.cloneElement(children, { onClick: () => onOpenChange?.(!open) });
    },
    PopoverContent: ({ children }: React.PropsWithChildren<unknown>) => {
      const { open } = React.useContext(Ctx);
      return open
        ? React.createElement("div", { "data-testid": "popover-content" }, children)
        : null;
    },
  };
});

import { McpActivityStrip } from "../McpActivityStrip";
import { formatCallDuration, groupCallsByTurn } from "../RecentCallsPopover";

function makeRecord(overrides: Partial<McpAuditRecord> = {}): McpAuditRecord {
  return {
    id: overrides.id ?? "rec-1",
    timestamp: overrides.timestamp ?? 0,
    toolId: overrides.toolId ?? "tool",
    sessionId: overrides.sessionId ?? "session-a",
    tier: overrides.tier ?? "workbench",
    argsSummary: overrides.argsSummary ?? "{}",
    result: overrides.result ?? "success",
    durationMs: overrides.durationMs ?? 10,
    schemaVersion: overrides.schemaVersion ?? 1,
    severity: overrides.severity ?? "info",
    ...overrides,
  };
}

const getAuditRecords = vi.fn();

beforeEach(() => {
  getAuditRecords.mockReset();
  getAuditRecords.mockResolvedValue([]);
  Object.defineProperty(globalThis, "window", {
    value: { electron: { mcpServer: { getAuditRecords } } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("formatCallDuration", () => {
  it("renders boundary durations", () => {
    expect(formatCallDuration(0)).toBe("0ms");
    expect(formatCallDuration(-5)).toBe("0ms");
    expect(formatCallDuration(50)).toBe("<100ms");
    expect(formatCallDuration(99)).toBe("<100ms");
    expect(formatCallDuration(100)).toBe("100ms");
    expect(formatCallDuration(999)).toBe("999ms");
    expect(formatCallDuration(1000)).toBe("1.0s");
    expect(formatCallDuration(1500)).toBe("1.5s");
  });
});

describe("groupCallsByTurn", () => {
  it("returns an empty array for no records", () => {
    expect(groupCallsByTurn([])).toEqual([]);
  });

  it("groups records by turnId preserving input order", () => {
    const records = [
      makeRecord({ id: "a", turnId: "t1" }),
      makeRecord({ id: "b", turnId: "t2" }),
      makeRecord({ id: "c", turnId: "t1" }),
    ];
    const groups = groupCallsByTurn(records);
    expect(groups.map((g) => g.turnId)).toEqual(["t1", "t2"]);
    expect(groups[0]!.records.map((r) => r.id)).toEqual(["a", "c"]);
    expect(groups[1]!.records.map((r) => r.id)).toEqual(["b"]);
  });

  it("collapses records without a turnId into a trailing null group", () => {
    const records = [
      makeRecord({ id: "a", turnId: "t1" }),
      makeRecord({ id: "b" }),
      makeRecord({ id: "c" }),
    ];
    const groups = groupCallsByTurn(records);
    const last = groups[groups.length - 1]!;
    expect(last.turnId).toBeNull();
    expect(last.records.map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("McpActivityStrip", () => {
  it("renders nothing when the session is hibernated (empty sessionId)", () => {
    const { container } = render(<McpActivityStrip sessionId="" onOpenSettings={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a trigger button for an active session", () => {
    render(<McpActivityStrip sessionId="session-a" onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("button", { name: /recent activity/i })).toBeTruthy();
    expect(getAuditRecords).not.toHaveBeenCalled();
  });

  it("fetches and renders the session's calls on open", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "alpha-tool", sessionId: "session-a" }),
      makeRecord({ id: "2", toolId: "beta-tool", sessionId: "session-a" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /recent activity/i }));
    expect(await screen.findByText("alpha-tool")).toBeTruthy();
    expect(screen.getByText("beta-tool")).toBeTruthy();
  });

  it("filters out records from other sessions", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "mine", sessionId: "session-a" }),
      makeRecord({ id: "2", toolId: "theirs", sessionId: "session-b" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /recent activity/i }));
    expect(await screen.findByText("mine")).toBeTruthy();
    expect(screen.queryByText("theirs")).toBeNull();
  });

  it("keeps only the 20 newest calls", async () => {
    const records = Array.from({ length: 21 }, (_, i) =>
      makeRecord({ id: `r${i}`, toolId: `tool-${i}`, sessionId: "session-a" })
    );
    getAuditRecords.mockResolvedValue(records);
    render(<McpActivityStrip sessionId="session-a" onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /recent activity/i }));
    expect(await screen.findByText("tool-0")).toBeTruthy();
    expect(screen.getByText("tool-19")).toBeTruthy();
    // slice(0, 20) keeps the newest-first leading 20; the 21st is dropped.
    expect(screen.queryByText("tool-20")).toBeNull();
  });

  it("shows an error state when the fetch rejects", async () => {
    getAuditRecords.mockRejectedValue(new Error("boom"));
    render(<McpActivityStrip sessionId="session-a" onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /recent activity/i }));
    expect(await screen.findByText(/couldn't load recent calls/i)).toBeTruthy();
  });

  it("renders the empty state when the session has no calls", async () => {
    getAuditRecords.mockResolvedValue([]);
    render(<McpActivityStrip sessionId="session-a" onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /recent activity/i }));
    expect(await screen.findByText(/no calls yet this session/i)).toBeTruthy();
  });

  it("invokes onOpenSettings and closes when viewing the full audit log", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "alpha-tool", sessionId: "session-a" }),
    ]);
    const onOpenSettings = vi.fn();
    render(<McpActivityStrip sessionId="session-a" onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: /recent activity/i }));
    const footer = await screen.findByRole("button", { name: /view full audit log/i });
    fireEvent.click(footer);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("popover-content")).toBeNull();
  });
});
