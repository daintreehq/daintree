// @vitest-environment jsdom
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import * as notifyLib from "@/lib/notify";
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
  setSessionQuietUntil: vi.fn(),
}));

let entryCounter = 0;

function makeEntry(overrides: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    id: `entry-${++entryCounter}`,
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
  useNotificationSettingsStore.setState({
    quietUntil: 0,
    quietHoursEnabled: false,
    quietHoursStartMin: 22 * 60,
    quietHoursEndMin: 8 * 60,
    quietHoursWeekdays: [],
  });
  dispatchMock.mockClear();
  getMock.mockReturnValue(null);
  vi.mocked(notifyLib.muteForDuration).mockClear();
  vi.mocked(notifyLib.muteUntilNextMorning).mockClear();
  vi.mocked(notifyLib.notify).mockClear();
  vi.mocked(notifyLib.setSessionQuietUntil).mockClear();
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

describe("NotificationCenter pause menu", () => {
  it("does not render the legacy Mute / Until morning / Configure buttons", () => {
    render(<NotificationCenter open onClose={() => {}} />);
    expect(screen.queryByText("Mute 1h")).toBeNull();
    expect(screen.queryByText("Until morning")).toBeNull();
    expect(screen.queryByText("Configure")).toBeNull();
  });

  it("does not render legacy controls even when entries exist and pause menu is open", async () => {
    setEntries([makeEntry()]);
    render(<NotificationCenter open onClose={() => {}} />);
    const trigger = screen.getByLabelText("Pause notifications");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    expect(screen.queryByText("Mute 1h")).toBeNull();
    expect(screen.queryByText("Until morning")).toBeNull();
    expect(screen.queryByText("Configure")).toBeNull();
  });

  it("opens a Pause menu and routes 'For 1 hour' to muteForDuration without dispatching settings", async () => {
    render(<NotificationCenter open onClose={() => {}} />);
    const trigger = screen.getByLabelText("Pause notifications");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    const oneHour = screen.getByText("For 1 hour");
    await act(async () => {
      fireEvent.click(oneHour);
    });

    expect(vi.mocked(notifyLib.muteForDuration)).toHaveBeenCalledWith(60 * 60 * 1000);
    expect(vi.mocked(notifyLib.notify)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Notifications muted",
        priority: "high",
        duration: 3000,
        urgent: true,
      })
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("routes the morning mute option to muteUntilNextMorning", async () => {
    render(<NotificationCenter open onClose={() => {}} />);
    const trigger = screen.getByLabelText("Pause notifications");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    // Label is locale-formatted (e.g. "Until 8:00 AM" or "Until 8:00") — match the prefix.
    await act(async () => {
      fireEvent.click(screen.getByText(/^Until 8:00/));
    });

    expect(vi.mocked(notifyLib.muteUntilNextMorning)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyLib.notify)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Notifications muted",
        priority: "high",
        duration: 3000,
        urgent: true,
      })
    );
  });

  it("dispatches notification settings tab from the footer link", async () => {
    const onClose = vi.fn();
    render(<NotificationCenter open onClose={onClose} />);
    const trigger = screen.getByLabelText("Pause notifications");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Notification settings"));
    });

    expect(onClose).toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "notifications" },
      { source: "user" }
    );
  });

  it("dispatches notification settings tab from 'Custom…' (deferred picker stub)", async () => {
    const onClose = vi.fn();
    render(<NotificationCenter open onClose={onClose} />);
    const trigger = screen.getByLabelText("Pause notifications");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Custom…"));
    });

    expect(onClose).toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "notifications" },
      { source: "user" }
    );
  });
});

describe("NotificationCenter muted pill", () => {
  it("does not render the pill when neither session nor scheduled mute is active", () => {
    render(<NotificationCenter open onClose={() => {}} />);
    expect(screen.queryByTestId("notification-muted-pill")).toBeNull();
  });

  it("renders a session-mute pill with formatted end time and a Resume ✕ button", () => {
    const until = Date.now() + 60 * 60 * 1000;
    useNotificationSettingsStore.setState({ quietUntil: until });

    render(<NotificationCenter open onClose={() => {}} />);

    const pill = screen.getByTestId("notification-muted-pill");
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain("Notifications");
    expect(pill.textContent).toMatch(/Muted until /);
    expect(screen.getByLabelText("Resume notifications")).toBeTruthy();
  });

  it("clears only the session mute (not persistent quiet hours) when ✕ is clicked", () => {
    const until = Date.now() + 60 * 60 * 1000;
    useNotificationSettingsStore.setState({
      quietUntil: until,
      quietHoursEnabled: true,
    });

    render(<NotificationCenter open onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Resume notifications"));

    expect(vi.mocked(notifyLib.setSessionQuietUntil)).toHaveBeenCalledWith(0);
    // Persistent setting must not be touched.
    expect(useNotificationSettingsStore.getState().quietHoursEnabled).toBe(true);
  });

  it("clears the pill automatically when session mute expires", () => {
    vi.useFakeTimers();
    try {
      const until = Date.now() + 500;
      useNotificationSettingsStore.setState({ quietUntil: until });

      render(<NotificationCenter open onClose={() => {}} />);
      expect(screen.queryByTestId("notification-muted-pill")).toBeTruthy();

      act(() => {
        // Roll past the expiry; tick effect schedules a re-render at quietUntil + 50ms.
        vi.advanceTimersByTime(700);
      });

      expect(screen.queryByTestId("notification-muted-pill")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("when both session and scheduled mute are active, ✕ clears session only and the pill persists as 'Quiet hours'", () => {
    const fixedNow = new Date();
    fixedNow.setHours(2, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      useNotificationSettingsStore.setState({
        quietUntil: fixedNow.getTime() + 60 * 60 * 1000,
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 8 * 60,
        quietHoursWeekdays: [],
      });

      render(<NotificationCenter open onClose={() => {}} />);
      const resume = screen.getByLabelText("Resume notifications");

      act(() => {
        // Simulate setSessionQuietUntil clearing the reactive store like the real impl does.
        vi.mocked(notifyLib.setSessionQuietUntil).mockImplementation((ts: number) => {
          useNotificationSettingsStore.getState().setQuietUntil(ts);
        });
        fireEvent.click(resume);
      });

      expect(vi.mocked(notifyLib.setSessionQuietUntil)).toHaveBeenCalledWith(0);
      const pill = screen.getByTestId("notification-muted-pill");
      expect(pill.textContent).toContain("Quiet hours");
      expect(screen.queryByLabelText("Resume notifications")).toBeNull();
      expect(useNotificationSettingsStore.getState().quietHoursEnabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a scheduled-only pill without a Resume ✕ button", () => {
    // Window: 22:00 → 08:00 with 'now' fixed inside the window.
    const fixedNow = new Date();
    fixedNow.setHours(2, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 8 * 60,
        quietHoursWeekdays: [],
      });

      render(<NotificationCenter open onClose={() => {}} />);

      const pill = screen.getByTestId("notification-muted-pill");
      expect(pill.textContent).toContain("Quiet hours");
      expect(screen.queryByLabelText("Resume notifications")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
