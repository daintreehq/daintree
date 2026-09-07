// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
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
      return React.cloneElement(children, { onClick: () => onOpenChange?.(!open) } as Record<
        string,
        unknown
      >);
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
import { groupCallsByTurn } from "../RecentCallsPopover";
import type { McpToolActivityState } from "@/controllers/HelpSessionController";
import { __resetHelpSessionControllersForTests } from "@/controllers/helpSessionControllerRegistry";

function makeRecord(overrides: Partial<McpAuditRecord> = {}): McpAuditRecord {
  return {
    id: overrides.id ?? "rec-1",
    timestamp: overrides.timestamp ?? 0,
    toolId: overrides.toolId ?? "tool",
    // The renderer filters on helpSessionId — sessionId is the MCP
    // transport id and deliberately never matches the help session.
    sessionId: overrides.sessionId ?? "mcp-transport-1",
    helpSessionId: overrides.helpSessionId ?? "session-a",
    tier: overrides.tier ?? "workbench",
    argsSummary: overrides.argsSummary ?? "{}",
    result: overrides.result ?? "success",
    durationMs: overrides.durationMs ?? 10,
    schemaVersion: overrides.schemaVersion ?? 1,
    severity: overrides.severity ?? "info",
    ...overrides,
  };
}

function makeActivity(overrides: Partial<McpToolActivityState> = {}): McpToolActivityState {
  return {
    status: "in-flight",
    toolId: "terminal.getStatus",
    argsSummary: "{}",
    startedAt: 0,
    danger: false,
    callCount: 1,
    pendingCalls: 1,
    isError: false,
    ...overrides,
  } as McpToolActivityState;
}

const getAuditRecords = vi.fn();

beforeEach(() => {
  // #12108: controllers live in a per-view registry, not component
  // state, so they outlive a render and must be reset between tests.
  __resetHelpSessionControllersForTests();
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
    const { container } = render(<McpActivityStrip sessionId="" activity={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a trigger button for an active session", () => {
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    expect(screen.getByRole("button", { name: /recent tool calls/i })).toBeTruthy();
    expect(getAuditRecords).not.toHaveBeenCalled();
  });

  it("fetches and renders the session's calls on open", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "alpha-tool", helpSessionId: "session-a" }),
      makeRecord({ id: "2", toolId: "beta-tool", helpSessionId: "session-a" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText("alpha-tool")).toBeTruthy();
    expect(screen.getByText("beta-tool")).toBeTruthy();
  });

  it("labels the unassociated group so null-turn calls are explained (#10067)", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "no-turn-tool", helpSessionId: "session-a" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText("no-turn-tool")).toBeTruthy();
    expect(screen.getByText(/not tied to a turn/i)).toBeTruthy();
  });

  it("omits the unassociated label when every call has a turn (#10067)", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "turn-tool", helpSessionId: "session-a", turnId: "t1" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText("turn-tool")).toBeTruthy();
    expect(screen.queryByText(/not tied to a turn/i)).toBeNull();
  });

  it("filters out records from other sessions", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "mine", helpSessionId: "session-a" }),
      makeRecord({ id: "2", toolId: "theirs", helpSessionId: "session-b" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText("mine")).toBeTruthy();
    expect(screen.queryByText("theirs")).toBeNull();
  });

  it("keeps only the 5 newest calls", async () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      makeRecord({ id: `r${i}`, toolId: `tool-${i}`, helpSessionId: "session-a" })
    );
    getAuditRecords.mockResolvedValue(records);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText("tool-0")).toBeTruthy();
    expect(screen.getByText("tool-4")).toBeTruthy();
    // slice keeps the newest-first leading 5; the 6th is dropped.
    expect(screen.queryByText("tool-5")).toBeNull();
  });

  it("shows an error state when the fetch rejects", async () => {
    getAuditRecords.mockRejectedValue(new Error("boom"));
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText(/couldn't load recent calls/i)).toBeTruthy();
  });

  it("renders the empty state when the session has no calls", async () => {
    getAuditRecords.mockResolvedValue([]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText(/no calls yet this session/i)).toBeTruthy();
  });

  it("does not flash old-session records after the session changes mid-fetch", async () => {
    let resolveFirst: (v: McpAuditRecord[]) => void = () => {};
    const firstFetch = new Promise<McpAuditRecord[]>((res) => {
      resolveFirst = res;
    });
    getAuditRecords.mockReturnValueOnce(firstFetch);

    const { rerender } = render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));

    // Session changes before the in-flight session-a fetch resolves.
    rerender(<McpActivityStrip sessionId="session-b" activity={null} />);
    await act(async () => {
      resolveFirst([makeRecord({ id: "old", toolId: "stale-tool", helpSessionId: "session-a" })]);
      await firstFetch;
    });

    // Reopen under session-b — the stale session-a result must not appear.
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText(/no calls yet this session/i)).toBeTruthy();
    expect(screen.queryByText("stale-tool")).toBeNull();
  });

  it("ignores records whose transport sessionId happens to equal the help session id", async () => {
    // Regression: the popover used to filter on the MCP transport id, which
    // never equals the help-session id — the list rendered empty forever.
    getAuditRecords.mockResolvedValue([
      makeRecord({
        id: "1",
        toolId: "transport-only",
        sessionId: "session-a",
        helpSessionId: undefined,
      }),
      makeRecord({
        id: "2",
        toolId: "help-joined",
        sessionId: "mcp-transport-9",
        helpSessionId: "session-a",
      }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText("help-joined")).toBeTruthy();
    expect(screen.queryByText("transport-only")).toBeNull();
  });

  it("shows recency on the row and keeps the precise duration in the expanded detail", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({
        id: "1",
        toolId: "fresh.call",
        timestamp: Date.now() - 5_000,
        durationMs: 150,
      }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    await screen.findByRole("button", { name: /fresh\.call/ });
    // Recency, not duration — the duration is deliberately not displayed.
    expect(screen.getByText("just now")).toBeTruthy();
    expect(screen.queryByText("150ms")).toBeNull();
  });

  it("expands a call row to show its arguments and result output", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({
        id: "1",
        toolId: "terminal.getStatus",
        argsSummary: '{"terminalIds":"<object>"}',
        resultSummary: '{\n  "terminals": []\n}',
      }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const row = await screen.findByRole("button", { name: /terminal\.getStatus/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    // Collapsed: detail hidden.
    expect(screen.queryByText(/"terminals": \[\]/)).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/"terminalIds":"<object>"/)).toBeTruthy();
    expect(screen.getByText(/"terminals": \[\]/)).toBeTruthy();
    expect(screen.getByText("Success")).toBeTruthy();
    // Collapse again.
    fireEvent.click(row);
    expect(screen.queryByText(/"terminals": \[\]/)).toBeNull();
  });

  it("shows a no-output note when a call has no recorded result", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "legacy.call", resultSummary: undefined }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const row = await screen.findByRole("button", { name: /legacy\.call/ });
    fireEvent.click(row);
    expect(screen.getByText(/no output recorded for this call/i)).toBeTruthy();
  });

  it("renders a Retry-in-Ns hint on rate_limited records carrying resultMeta (#10014)", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({
        id: "1",
        toolId: "throttled.call",
        result: "rate_limited",
        resultSummary: undefined,
        resultMeta: { retryAfter: 5 },
      }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const row = await screen.findByRole("button", { name: /throttled\.call/ });
    fireEvent.click(row);
    expect(screen.getByText("Rate limited")).toBeTruthy();
    expect(screen.getByText("Retry in 5s")).toBeTruthy();
    // The no-output fallback must NOT appear when resultMeta carries the hint.
    expect(screen.queryByText(/no output recorded for this call/i)).toBeNull();
  });

  it("falls back to the no-output note for rate_limited records missing resultMeta (legacy rows)", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({
        id: "1",
        toolId: "legacy.throttled",
        result: "rate_limited",
        resultSummary: undefined,
      }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const row = await screen.findByRole("button", { name: /legacy\.throttled/ });
    fireEvent.click(row);
    expect(screen.queryByText(/retry in \d+s/i)).toBeNull();
    expect(screen.getByText(/no output recorded for this call/i)).toBeTruthy();
  });
});

describe("McpActivityStrip live activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("withholds the in-flight row during the Doherty gate, then shows it", () => {
    render(<McpActivityStrip sessionId="session-a" activity={makeActivity({ turnId: "t1" })} />);
    // Inside the gate the resting label holds — no spinner flash.
    expect(screen.getByText("Recent activity")).toBeTruthy();
    expect(screen.queryByText("terminal.getStatus")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText("terminal.getStatus")).toBeTruthy();
    expect(screen.queryByText("Recent activity")).toBeNull();
  });

  it("labels a coalesced same-turn burst with its call count", () => {
    render(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({ turnId: "t1", callCount: 2 })}
      />
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText("2 calls · terminal.getStatus")).toBeTruthy();
  });

  it("shows a settled call immediately, then decays to rest", () => {
    render(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({
          status: "settled",
          turnId: "t1",
          durationMs: 21,
          result: "success",
          severity: "info",
        })}
      />
    );
    // Settled rows skip the gate — a sub-400ms call renders its result directly.
    expect(screen.getByText("terminal.getStatus")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Recent activity")).toBeTruthy();
    expect(screen.queryByText("terminal.getStatus")).toBeNull();
  });

  it("keeps a settled error visible instead of decaying", () => {
    render(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({
          status: "settled",
          turnId: "t1",
          durationMs: 1200,
          result: "error",
          severity: "error",
          isError: true,
        })}
      />
    );
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("terminal.getStatus")).toBeTruthy();
    expect(screen.queryByText("Recent activity")).toBeNull();
  });

  it("keeps the button's accessible name stable while the live row morphs", () => {
    const { rerender } = render(<McpActivityStrip sessionId="session-a" activity={null} />);
    expect(screen.getByRole("button", { name: /recent tool calls/i })).toBeTruthy();
    rerender(<McpActivityStrip sessionId="session-a" activity={makeActivity({ turnId: "t1" })} />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole("button", { name: /recent tool calls/i })).toBeTruthy();
  });

  it("does not re-arm the gate for a same-turn call after a sub-400ms settle", () => {
    // Call 1 settles under the Doherty threshold: the settled row renders
    // directly, marking the turn's key as shown.
    const { rerender } = render(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({
          status: "settled",
          turnId: "t1",
          durationMs: 80,
          result: "success",
          severity: "info",
          pendingCalls: 0,
        })}
      />
    );
    expect(screen.getByText("terminal.getStatus")).toBeTruthy();
    // Call 2 starts in the same turn — the live row must appear immediately,
    // not flash back to "Recent activity" for another 400ms.
    rerender(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({ turnId: "t1", toolId: "terminal.sendText", callCount: 2 })}
      />
    );
    expect(screen.getByText("2 calls · terminal.sendText")).toBeTruthy();
    expect(screen.queryByText("Recent activity")).toBeNull();
  });
});
