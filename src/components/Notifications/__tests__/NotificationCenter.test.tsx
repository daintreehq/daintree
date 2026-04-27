// @vitest-environment jsdom
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { NotificationCenter } from "../NotificationCenter";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const getMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock, get: getMock },
}));

vi.mock("@/lib/notify", () => ({
  muteForDuration: vi.fn(),
  muteUntilNextMorning: vi.fn().mockReturnValue(Date.now() + 3600_000),
  notify: vi.fn(),
}));

function makeEntry(overrides: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    id: `entry-${Math.random()}`,
    type: "info",
    message: "Notification message",
    timestamp: Date.now(),
    seenAsToast: true,
    summarized: false,
    countable: true,
    ...overrides,
  };
}

function setEntries(entries: NotificationHistoryEntry[]) {
  const unreadCount = entries.filter((e) => !e.seenAsToast && e.countable !== false).length;
  useNotificationHistoryStore.setState({ entries, unreadCount });
}

beforeEach(() => {
  useNotificationHistoryStore.getState().clearAll();
  dispatchMock.mockClear();
  getMock.mockReturnValue(null);
});

describe("NotificationThread worst severity", () => {
  it("shows error icon for thread with [error, success] entries", async () => {
    const correlationId = "thread-1";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "error-entry",
        type: "error",
        message: "Failed to deploy",
        correlationId,
        timestamp: Date.now() - 2000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "success-entry",
        type: "success",
        message: "Deploy successful",
        correlationId,
        timestamp: Date.now() - 1000,
      })
    );

    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Deploy successful")).toBeTruthy();
    });

    const errorIcon = container.querySelector(".text-status-error");
    expect(errorIcon).toBeTruthy();
  });

  it("shows error icon for thread with [info, warning, error] entries", async () => {
    const correlationId = "thread-2";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "info-entry",
        type: "info",
        message: "Starting build",
        correlationId,
        timestamp: Date.now() - 3000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "warning-entry",
        type: "warning",
        message: "Slow dependency",
        correlationId,
        timestamp: Date.now() - 2000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "error-entry",
        type: "error",
        message: "Build failed",
        correlationId,
        timestamp: Date.now() - 1000,
      })
    );

    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Build failed")).toBeTruthy();
    });

    const errorIcon = container.querySelector(".text-status-error");
    expect(errorIcon).toBeTruthy();
  });

  it("shows warning icon for thread with [success, warning, info] entries", async () => {
    const correlationId = "thread-3";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "success-entry",
        type: "success",
        message: "Step 1 complete",
        correlationId,
        timestamp: Date.now() - 3000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "info-entry",
        type: "info",
        message: "Step 2 complete",
        correlationId,
        timestamp: Date.now() - 2000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "warning-entry",
        type: "warning",
        message: "Lint warnings found",
        correlationId,
        timestamp: Date.now() - 1000,
      })
    );

    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Lint warnings found")).toBeTruthy();
    });

    const warningIcon = container.querySelector(".text-status-warning");
    expect(warningIcon).toBeTruthy();
  });

  it("shows info icon for thread with [success, success, info] entries", async () => {
    const correlationId = "thread-4";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "success-entry-1",
        type: "success",
        message: "Part 1 done",
        correlationId,
        timestamp: Date.now() - 2000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "success-entry-2",
        type: "success",
        message: "Part 2 done",
        correlationId,
        timestamp: Date.now() - 1500,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "info-entry",
        type: "info",
        message: "Build complete",
        correlationId,
        timestamp: Date.now() - 1000,
      })
    );

    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Build complete")).toBeTruthy();
    });

    const infoIcon = container.querySelector(".text-status-info");
    expect(infoIcon).toBeTruthy();
  });

  it("shows success icon for thread with all success entries", async () => {
    const correlationId = "thread-5";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "success-entry-1",
        type: "success",
        message: "Step 1 done",
        correlationId,
        timestamp: Date.now() - 2000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "success-entry-2",
        type: "success",
        message: "Step 2 done",
        correlationId,
        timestamp: Date.now() - 1000,
      })
    );

    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Step 2 done")).toBeTruthy();
    });

    const successIcon = container.querySelector(".text-status-success");
    expect(successIcon).toBeTruthy();
  });
});

describe("NotificationThread with single entry", () => {
  it("displays single-entry notification without thread count", async () => {
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "solo-entry",
        type: "error",
        message: "Single error",
        correlationId: "solo-1",
      })
    );

    render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Single error")).toBeTruthy();
    });

    expect(screen.queryByText(/events$/)).toBeNull();
  });
});

describe("NotificationThread message content", () => {
  it("shows latest entry message even when worst severity is different", async () => {
    const correlationId = "thread-6";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "error-entry",
        type: "error",
        message: "Build failed",
        correlationId,
        timestamp: Date.now() - 2000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "success-entry",
        type: "success",
        message: "Build retried and succeeded",
        correlationId,
        timestamp: Date.now() - 1000,
      })
    );

    render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Build retried and succeeded")).toBeTruthy();
    });
  });
});

describe("NotificationCenter overflow menu", () => {
  it("does not render overflow trigger when there are no entries", () => {
    render(<NotificationCenter open onClose={() => {}} />);
    expect(screen.queryByLabelText("More notification actions")).toBeNull();
  });

  it("renders overflow trigger as a button when entries exist", () => {
    setEntries([makeEntry()]);
    render(<NotificationCenter open onClose={() => {}} />);
    const trigger = screen.getByLabelText("More notification actions");
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("calls clearAll before onClose and removes the trigger when 'Clear all' is selected", async () => {
    const callOrder: string[] = [];
    const originalClearAll = useNotificationHistoryStore.getState().clearAll;
    const clearAllSpy = vi.fn(() => {
      callOrder.push("clearAll");
      originalClearAll();
    });
    useNotificationHistoryStore.setState({ clearAll: clearAllSpy });

    setEntries([makeEntry(), makeEntry({ id: "entry-2" })]);
    const onClose = vi.fn(() => {
      callOrder.push("onClose");
    });
    render(<NotificationCenter open onClose={onClose} />);

    const trigger = screen.getByLabelText("More notification actions");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    const clearItem = screen.getByText("Clear all");
    await act(async () => {
      fireEvent.click(clearItem);
    });

    expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["clearAll", "onClose"]);
    expect(screen.queryByLabelText("More notification actions")).toBeNull();
  });
});
