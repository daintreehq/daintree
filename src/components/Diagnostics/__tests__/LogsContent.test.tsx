// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { LogEntry } from "@shared/types";
import { LogsContent } from "../LogsContent";
import { useLogsStore } from "@/store";

vi.mock("../../Logs/LogFilters", () => ({
  LogFilters: () => <div data-testid="log-filters" />,
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data }: { data: unknown[] }) => (
    <div data-testid="virtuoso" data-count={data.length} />
  ),
}));

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

  it("does not show the filtered-empty action when filters are inactive", async () => {
    mockGetAll.mockResolvedValue([makeLog("a", { level: "info" })]);
    useLogsStore.setState({ filters: {} });
    const { queryByText, findByTestId } = render(<LogsContent />);

    await findByTestId("virtuoso");
    await waitFor(() => {
      expect(queryByText("No logs match filters")).toBeNull();
      expect(queryByText("Clear filters")).toBeNull();
    });
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
