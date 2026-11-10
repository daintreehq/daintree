// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { LogEntry } from "@shared/types";
import { LogsContent } from "../LogsContent";
import { useLogsStore } from "@/store";

vi.mock("../../Logs/LogFilters", () => ({
  LogFilters: () => <div data-testid="log-filters" />,
}));

type FollowOutput = (isAtBottom: boolean) => "smooth" | "auto" | false;

const virtuoso = vi.hoisted(() => ({
  props: null as {
    atBottomStateChange: (bottom: boolean) => void;
    followOutput: false | FollowOutput;
  } | null,
  scrollToIndex: vi.fn(),
}));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(function VirtuosoMock(
      props: { data: unknown[] } & NonNullable<typeof virtuoso.props>,
      ref: React.Ref<{ scrollToIndex: typeof virtuoso.scrollToIndex }>
    ) {
      virtuoso.props = props;
      React.useImperativeHandle(ref, () => ({ scrollToIndex: virtuoso.scrollToIndex }));
      return <div data-testid="virtuoso" data-count={props.data.length} />;
    }),
  };
});

const mockGetAll = vi.fn<() => Promise<LogEntry[]>>().mockResolvedValue([]);
const mockGetSources = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);

vi.mock("@/clients", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logsClient: {
      getAll: () => mockGetAll(),
      getSources: () => mockGetSources(),
      onBatch: () => () => {},
    },
    appClient: {
      getVersion: vi.fn().mockResolvedValue("1.0.0"),
    },
  };
});

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

function makeLog(id: string, overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    timestamp: Date.now(),
    level: "info",
    message: `log ${id}`,
    ...overrides,
  };
}

describe("LogsContent — filtered-empty recovery", () => {
  beforeEach(() => {
    mockGetAll.mockReset().mockResolvedValue([]);
    mockGetSources.mockReset().mockResolvedValue([]);
    useLogsStore.setState({
      logs: [],
      filters: {},
      autoScroll: true,
      expandedIds: new Set(),
    });
  });

  it("shows EmptyState with Clear filters action when filters hide all logs", async () => {
    mockGetAll.mockResolvedValue([makeLog("a", { level: "error" })]);
    useLogsStore.setState({ filters: { levels: ["debug"] } });

    const { findByText, queryByTestId } = render(<LogsContent />);

    expect(await findByText("No logs match filters")).toBeTruthy();
    expect(queryByTestId("virtuoso")).toBeNull();

    const button = await findByText("Clear filters");
    await act(async () => {
      fireEvent.click(button);
    });

    expect(useLogsStore.getState().filters).toEqual({});
  });

  it("does not show the filtered-empty action when there are no logs at all", async () => {
    mockGetAll.mockResolvedValue([]);
    const { findByText, queryByText } = render(<LogsContent />);

    expect(await findByText("No logs yet")).toBeTruthy();
    expect(queryByText("Clear filters")).toBeNull();
  });

  it("shows user-cleared empty state when only the previous-session separator remains", async () => {
    mockGetAll.mockResolvedValue([
      makeLog("previous-session-separator", { context: { tail: "old log line" } }),
    ]);
    const { findByText, queryByText } = render(<LogsContent />);

    expect(await findByText("No new logs this session")).toBeTruthy();
    expect(queryByText("No logs yet")).toBeNull();
    expect(queryByText("Clear filters")).toBeNull();
  });

  it("does not mistake the separator-only state for filtered-empty when a filter is active", async () => {
    mockGetAll.mockResolvedValue([
      makeLog("previous-session-separator", { context: { tail: "old log line" } }),
    ]);
    useLogsStore.setState({ filters: { levels: ["error"] } });
    const { findByText, queryByText } = render(<LogsContent />);

    expect(await findByText("No new logs this session")).toBeTruthy();
    expect(queryByText("No logs match filters")).toBeNull();
    expect(queryByText("Clear filters")).toBeNull();
  });

  it("does not flag inert filter keys (undefined values) as active", async () => {
    mockGetAll.mockResolvedValue([makeLog("a", { level: "info" })]);
    useLogsStore.setState({ filters: { search: undefined, levels: [] } });
    const { queryByText, findByTestId } = render(<LogsContent />);

    await findByTestId("virtuoso");
    await waitFor(() => {
      expect(queryByText("No logs match filters")).toBeNull();
    });
  });
});

describe("LogsContent — failed reads", () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockGetSources.mockReset().mockResolvedValue([]);
    useLogsStore.setState({ logs: [], filters: {}, autoScroll: true, expandedIds: new Set() });
  });

  it("keeps the entries already on screen when a read fails", async () => {
    // Entries that arrived live after an earlier failed read, then a Retry fails too.
    useLogsStore.setState({ logs: [makeLog("live-1"), makeLog("live-2")] });
    mockGetAll.mockRejectedValue(new Error("log buffer unavailable"));

    render(<LogsContent />);

    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useLogsStore.getState().logs.map((l) => l.id)).toEqual(["live-1", "live-2"]);
  });

  it("replaces the list with the read when it succeeds", async () => {
    useLogsStore.setState({ logs: [makeLog("stale")] });
    mockGetAll.mockResolvedValue([makeLog("fresh")]);

    render(<LogsContent />);

    await waitFor(() => expect(useLogsStore.getState().logs.map((l) => l.id)).toEqual(["fresh"]));
  });
});

describe("LogsContent — auto-scroll follows the toggle and the scroll position", () => {
  const reportBottom = (bottom: boolean) => act(() => virtuoso.props?.atBottomStateChange(bottom));
  const setFlag = (value: boolean) => act(() => useLogsStore.getState().setAutoScroll(value));
  const renderList = async () => {
    const view = render(<LogsContent />);
    await view.findByTestId("virtuoso");
    await waitFor(() => expect(useLogsStore.getState().logs.length).toBeGreaterThan(0));
    return view;
  };

  beforeEach(() => {
    mockGetAll.mockReset().mockResolvedValue([makeLog("a"), makeLog("b")]);
    mockGetSources.mockReset().mockResolvedValue([]);
    virtuoso.props = null;
    virtuoso.scrollToIndex.mockReset();
    useLogsStore.setState({ logs: [], filters: {}, autoScroll: true, expandedIds: new Set() });
  });

  it("scrolls the newest line into view when the toggle turns on while scrolled away", async () => {
    const { queryByText } = await renderList();
    reportBottom(true);
    reportBottom(false);
    expect(useLogsStore.getState().autoScroll).toBe(false);
    expect(queryByText("Jump to latest")).not.toBeNull();

    setFlag(true);

    expect(virtuoso.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuoso.scrollToIndex.mock.calls[0]?.[0]).toMatchObject({ index: "LAST" });
    // Virtuoso reports the bottom once the scroll lands, and the pill goes with it.
    reportBottom(true);
    expect(queryByText("Jump to latest")).toBeNull();
    expect(useLogsStore.getState().autoScroll).toBe(true);
    expect(virtuoso.props?.followOutput).toBeTypeOf("function");
    expect((virtuoso.props?.followOutput as FollowOutput)(true)).not.toBe(false);
  });

  it("scrolls once when the pill resumes following", async () => {
    const { findByText } = await renderList();
    reportBottom(true);
    reportBottom(false);

    fireEvent.click(await findByText("Jump to latest"));

    expect(useLogsStore.getState().autoScroll).toBe(true);
    expect(virtuoso.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("scrolls again when the pill is used while the flag is already on", async () => {
    const { findByText } = await renderList();
    reportBottom(true);
    reportBottom(false);
    // Scrolled away, but the flag has not caught up yet (it is still on).
    setFlag(true);
    virtuoso.scrollToIndex.mockClear();

    fireEvent.click(await findByText("Jump to latest"));

    expect(virtuoso.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("does not scroll when the toggle turns on while already at the bottom", async () => {
    await renderList();
    reportBottom(true);
    setFlag(false);
    expect(virtuoso.props?.followOutput).toBe(false);

    setFlag(true);

    expect(virtuoso.scrollToIndex).not.toHaveBeenCalled();
  });

  it("resumes following when the list is scrolled back to the bottom by hand", async () => {
    await renderList();
    reportBottom(true);
    reportBottom(false);
    expect(useLogsStore.getState().autoScroll).toBe(false);

    reportBottom(true);

    expect(useLogsStore.getState().autoScroll).toBe(true);
    // Reaching the bottom is the user's own scroll: nothing should animate.
    expect(virtuoso.scrollToIndex).not.toHaveBeenCalled();
  });

  it("counts lines that arrive while scrolled away and clears the count on resume", async () => {
    mockGetAll.mockResolvedValue([makeLog("a", { timestamp: 1 }), makeLog("b", { timestamp: 2 })]);
    const { findByText, queryByText } = await renderList();
    reportBottom(true);
    reportBottom(false);

    act(() => useLogsStore.getState().addLogs([makeLog("c", { timestamp: 3, message: "c" })]));
    expect(await findByText("1 new")).not.toBeNull();

    setFlag(true);
    reportBottom(true);

    expect(queryByText("1 new")).toBeNull();
    expect(queryByText("Jump to latest")).toBeNull();
  });

  it("keeps following off when the toggle is turned off at the bottom", async () => {
    await renderList();
    reportBottom(true);

    setFlag(false);

    expect(useLogsStore.getState().autoScroll).toBe(false);
    expect(virtuoso.props?.followOutput).toBe(false);
    expect(virtuoso.scrollToIndex).not.toHaveBeenCalled();
  });

  it("keeps a flag switched off at the bottom off when the bottom is reported again", async () => {
    await renderList();
    reportBottom(true);
    setFlag(false);

    reportBottom(true);

    expect(useLogsStore.getState().autoScroll).toBe(false);
  });

  it("does not turn a flag the user switched off back on when the list first opens at the bottom", async () => {
    useLogsStore.setState({ autoScroll: false });
    await renderList();

    reportBottom(true);

    expect(useLogsStore.getState().autoScroll).toBe(false);
  });
});
