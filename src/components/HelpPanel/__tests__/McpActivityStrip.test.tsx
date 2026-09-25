// @vitest-environment jsdom
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpAuditRecord } from "@shared/types";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

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

// Passthrough tooltip: the footer mounts the provider, which a unit render of
// this component alone does not have.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}));

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
    tier: overrides.tier ?? "core",
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
  // On the real jsdom window, not a stand-in object: the popover's age ticker
  // reaches for window timers.
  Object.defineProperty(window, "electron", {
    value: { mcpServer: { getAuditRecords } },
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
    expect(screen.getByText(/outside any turn/i)).toBeTruthy();
  });

  it("omits the unassociated label when every call has a turn (#10067)", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "turn-tool", helpSessionId: "session-a", turnId: "t1" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    expect(await screen.findByText("turn-tool")).toBeTruthy();
    expect(screen.queryByText(/outside any turn/i)).toBeNull();
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
    expect(await screen.findByText(/to see its tool calls here/i)).toBeTruthy();
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
    expect(await screen.findByText(/to see its tool calls here/i)).toBeTruthy();
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

  it("renders the server's requested wait on rate_limited records carrying resultMeta (#10014)", async () => {
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
    // Historical wording: the row can be minutes old, so a "retry in" countdown
    // would describe a wait that has already passed.
    expect(screen.getByText("Asked to retry after 5s")).toBeTruthy();
    expect(screen.queryByText(/retry in \d+s/i)).toBeNull();
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
    expect(screen.queryByText(/retry after \d+s/i)).toBeNull();
    expect(screen.getByText(/no output recorded for this call/i)).toBeTruthy();
  });

  it("points every disclosure at a panel that exists, collapsed or expanded", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "one.call", turnId: "t1", resultSummary: "ok" }),
      makeRecord({ id: "2", toolId: "two.call", resultSummary: "ok" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    await screen.findByRole("button", { name: /one\.call/ });
    const rows = screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"));
    expect(rows.length).toBe(2);
    for (const expanded of [false, true]) {
      for (const row of rows) {
        if (expanded) fireEvent.click(row);
        const id = row.getAttribute("aria-controls");
        expect(id).toBeTruthy();
        expect(document.getElementById(id!)).not.toBeNull();
      }
    }
  });

  it("names every group of calls with a visible heading", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "newest", turnId: "t2" }),
      makeRecord({ id: "2", toolId: "older", turnId: "t1" }),
      makeRecord({ id: "3", toolId: "loose" }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    await screen.findByText("newest");
    const lists = Array.from(screen.getByTestId("popover-content").querySelectorAll("ul ul"));
    expect(lists.length).toBe(3);
    const names = lists.map((list) => {
      const heading = document.getElementById(list.getAttribute("aria-labelledby") ?? "");
      return heading?.textContent?.trim() ?? "";
    });
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names.slice(0, 2)).size).toBe(2);
  });

  it("keeps payloads inside the one list scroller rather than their own", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({
        id: "1",
        toolId: "big.call",
        argsSummary: '{"a":1}',
        resultSummary: "x\n".repeat(200),
      }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    fireEvent.click(await screen.findByRole("button", { name: /big\.call/ }));
    const scrollers = Array.from(
      screen.getByTestId("popover-content").querySelectorAll("*")
    ).filter((el) =>
      /(^|\s)overflow-(y-)?(auto|scroll)(\s|$)/.test(el.getAttribute("class") ?? "")
    );
    expect(scrollers.length).toBe(1);
  });

  it("tells a blocked call what tool set would have let it through", async () => {
    getAuditRecords.mockResolvedValue([
      makeRecord({ id: "1", toolId: "hinted", result: "unauthorized", tierHint: "full" }),
      makeRecord({ id: "2", toolId: "nowhere", result: "unauthorized", tierHint: null }),
    ]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    fireEvent.click(await screen.findByRole("button", { name: /hinted/ }));
    fireEvent.click(screen.getByRole("button", { name: /nowhere/ }));
    expect(screen.getByText("Needs the Full tool set")).toBeTruthy();
    expect(screen.getByText(/not permitted at any tier/i)).toBeTruthy();
  });

  // Records written before the core/full split carry the old ladder names. The
  // popover shows what was recorded, as history, rather than guessing it onto
  // the new pair or naming a tool set that does not exist.
  it("shows a pre-split tier hint as a former tier", async () => {
    // Widened after construction because the current type no longer admits
    // the value a record on disk can still hold.
    const legacy = Object.assign(
      makeRecord({ id: "1", toolId: "legacy", result: "unauthorized" }),
      { tierHint: "action" }
    );
    getAuditRecords.mockResolvedValue([legacy]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    fireEvent.click(await screen.findByRole("button", { name: /legacy/ }));
    expect(screen.getByText("Needed the former action tier")).toBeTruthy();
    expect(screen.queryByText(/action tool set/)).toBeNull();
  });

  it("offers a retry after a failed read, and it reads again", async () => {
    getAuditRecords.mockRejectedValueOnce(new Error("boom"));
    getAuditRecords.mockResolvedValue([makeRecord({ id: "1", toolId: "recovered" })]);
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("recovered")).toBeTruthy();
  });

  it("links to the full audit log and closes on the way", async () => {
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    fireEvent.click(await screen.findByRole("button", { name: /open full audit log/i }));
    expect(dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      expect.objectContaining({ tab: "mcp" }),
      { source: "user" }
    );
    expect(screen.queryByTestId("popover-content")).toBeNull();
  });

  it("keeps the rows it already read when a refresh fails", async () => {
    getAuditRecords.mockResolvedValueOnce([makeRecord({ id: "1", toolId: "kept" })]);
    const { rerender } = render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const popover = await screen.findByTestId("popover-content");
    await within(popover).findByText("kept");
    getAuditRecords.mockRejectedValueOnce(new Error("boom"));
    rerender(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({ status: "settled", toolId: "next", startedAt: 9 })}
      />
    );
    expect(await within(popover).findByText(/couldn't refresh/i)).toBeTruthy();
    expect(within(popover).getByText("kept")).toBeTruthy();
  });

  it("keeps Retry mounted while it works, then hands focus to the first call", async () => {
    getAuditRecords.mockRejectedValueOnce(new Error("boom"));
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.focus();

    let resolveRetry: (v: McpAuditRecord[]) => void = () => {};
    getAuditRecords.mockReturnValueOnce(
      new Promise<McpAuditRecord[]>((res) => {
        resolveRetry = res;
      })
    );
    fireEvent.click(retry);
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
    expect(document.activeElement).toBe(retry);

    await act(async () => {
      resolveRetry([makeRecord({ id: "1", toolId: "back" })]);
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /back/ }));
  });

  it("leaves focus where the user moved it while a retry was in flight", async () => {
    getAuditRecords.mockRejectedValueOnce(new Error("boom"));
    render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.focus();

    let resolveRetry: (v: McpAuditRecord[]) => void = () => {};
    getAuditRecords.mockReturnValueOnce(
      new Promise<McpAuditRecord[]>((res) => {
        resolveRetry = res;
      })
    );
    fireEvent.click(retry);
    const footer = screen.getByRole("button", { name: /open full audit log/i });
    footer.focus();

    await act(async () => {
      resolveRetry([makeRecord({ id: "1", toolId: "back" })]);
    });
    expect(document.activeElement).toBe(footer);
  });

  it("marks a background-refresh error row busy while its retry is in flight", async () => {
    getAuditRecords.mockResolvedValueOnce([makeRecord({ id: "1", toolId: "kept" })]);
    const { rerender } = render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const popover = await screen.findByTestId("popover-content");
    await within(popover).findByText("kept");
    getAuditRecords.mockRejectedValueOnce(new Error("boom"));
    rerender(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({ status: "settled", toolId: "next", startedAt: 9 })}
      />
    );
    const retry = await within(popover).findByRole("button", { name: "Retry" });
    expect(within(popover).getByRole("alert").getAttribute("aria-busy")).toBeNull();

    getAuditRecords.mockReturnValueOnce(new Promise<McpAuditRecord[]>(() => {}));
    fireEvent.click(retry);
    expect(within(popover).getByRole("alert").getAttribute("aria-busy")).toBe("true");
  });

  it("re-reads the list when a call settles while it is open", async () => {
    getAuditRecords.mockResolvedValueOnce([makeRecord({ id: "1", toolId: "first" })]);
    const { rerender } = render(<McpActivityStrip sessionId="session-a" activity={null} />);
    fireEvent.click(screen.getByRole("button", { name: /recent tool calls/i }));
    const popover = await screen.findByTestId("popover-content");
    await within(popover).findByText("first");

    let resolveRefresh: (v: McpAuditRecord[]) => void = () => {};
    getAuditRecords.mockReturnValueOnce(
      new Promise<McpAuditRecord[]>((res) => {
        resolveRefresh = res;
      })
    );
    rerender(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({ status: "settled", toolId: "second", startedAt: 5 })}
      />
    );
    // Mid-refresh the existing rows stay put rather than blanking to a skeleton.
    expect(getAuditRecords).toHaveBeenCalledTimes(2);
    expect(within(popover).getByText("first")).toBeTruthy();
    expect(within(popover).queryByRole("status")).toBeNull();

    await act(async () => {
      resolveRefresh([
        makeRecord({ id: "2", toolId: "second" }),
        makeRecord({ id: "1", toolId: "first" }),
      ]);
    });
    expect(within(popover).getByText("second")).toBeTruthy();
  });
});

/** The trigger's visible text: empty at rest, where only the glyph shows. */
function liveText(): string {
  return screen.getByRole("button", { name: /recent tool calls/i }).textContent ?? "";
}

describe("McpActivityStrip live activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("withholds the in-flight row during the Doherty gate, then shows it", () => {
    render(<McpActivityStrip sessionId="session-a" activity={makeActivity({ turnId: "t1" })} />);
    // Inside the gate the resting glyph holds — no spinner flash.
    expect(liveText()).toBe("");
    expect(screen.queryByText("terminal.getStatus")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText("terminal.getStatus")).toBeTruthy();
    expect(liveText()).not.toBe("");
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
    expect(liveText()).toBe("");
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
    expect(liveText()).not.toBe("");
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
    // not flash back to the resting glyph for another 400ms.
    rerender(
      <McpActivityStrip
        sessionId="session-a"
        activity={makeActivity({ turnId: "t1", toolId: "terminal.sendText", callCount: 2 })}
      />
    );
    expect(screen.getByText("2 calls · terminal.sendText")).toBeTruthy();
    expect(liveText()).not.toBe("");
  });
});
