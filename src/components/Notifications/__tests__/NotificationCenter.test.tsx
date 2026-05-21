// @vitest-environment jsdom
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useUIStore } from "@/store/uiStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import * as notifyLib from "@/lib/notify";
import { NotificationCenter } from "../NotificationCenter";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const getMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock, get: getMock },
}));

vi.mock("@/lib/notify", () => ({
  isNotificationEventKind: vi.fn(
    (v: string | undefined) =>
      v === "completed" || v === "waiting" || v === "workingPulse" || v === "uiFeedback"
  ),
  muteForDuration: vi.fn(),
  muteUntilNextMorning: vi.fn().mockReturnValue(Date.now() + 3600_000),
  notify: vi.fn(),
  setSessionQuietUntil: vi.fn(),
}));

const worktreeStoreMock = vi.hoisted(() => ({
  worktrees: new Map<string, { worktreeId: string; name: string }>(),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: <T,>(selector: (state: typeof worktreeStoreMock) => T) =>
    selector(worktreeStoreMock),
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
    archivedAt: null,
    ...overrides,
  };
}

function setEntries(entries: NotificationHistoryEntry[]) {
  const unreadCount = entries.filter(
    (e) => !e.seenAsToast && e.countable !== false && !e.archivedAt
  ).length;
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
    groupByContext: false,
  });
  useUIStore.setState({
    notificationCenterOpen: false,
    lastNotificationCenterClosedAt: 0,
  });
  worktreeStoreMock.worktrees.clear();
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

    // Worst severity (error) disagrees with the latest entry (success), so the
    // preview is prefixed to flag the icon/text divergence.
    await waitFor(() => {
      expect(screen.queryAllByText("Latest: Deploy successful").length).toBeGreaterThan(0);
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
      expect(screen.queryAllByText("Build failed").length).toBeGreaterThan(0);
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
      expect(screen.queryAllByText("Lint warnings found").length).toBeGreaterThan(0);
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
      expect(screen.queryAllByText("Single error").length).toBeGreaterThan(0);
    });

    expect(screen.queryByText(/events$/)).toBeNull();
  });
});

describe("NotificationThread message content", () => {
  it("prefixes the preview with 'Latest:' when worst severity disagrees with the latest entry", async () => {
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
      expect(screen.queryAllByText("Latest: Build retried and succeeded").length).toBeGreaterThan(
        0
      );
    });
    expect(screen.queryByText("Build retried and succeeded")).toBeNull();
  });

  it("omits the 'Latest:' prefix when the latest entry already matches the worst severity", async () => {
    const correlationId = "thread-7";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "error-entry-1",
        type: "error",
        message: "Build failed",
        correlationId,
        timestamp: Date.now() - 2000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "error-entry-2",
        type: "error",
        message: "Build failed again",
        correlationId,
        timestamp: Date.now() - 1000,
      })
    );

    render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryAllByText("Build failed again").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Latest: Build failed again")).toBeNull();
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
    expect(vi.mocked(notifyLib.notify)).not.toHaveBeenCalled();
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

    // Label is locale-formatted (e.g. "Until 8:00 AM" or "Until 08:00") — match the prefix.
    await act(async () => {
      fireEvent.click(screen.getByText(/^Until \d{1,2}:00/));
    });

    expect(vi.mocked(notifyLib.muteUntilNextMorning)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyLib.notify)).not.toHaveBeenCalled();
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

  it("renders a session-mute pill with formatted end time and a Resume button", () => {
    const until = Date.now() + 60 * 60 * 1000;
    useNotificationSettingsStore.setState({ quietUntil: until });

    render(<NotificationCenter open onClose={() => {}} />);

    const pill = screen.getByTestId("notification-muted-pill");
    expect(pill).toBeTruthy();
    expect(pill.textContent).toMatch(/Muted until /);
    const resume = screen.getByLabelText("Resume notifications");
    expect(resume).toBeTruthy();
    expect(resume.textContent).toBe("Resume");
    expect(resume.querySelector("svg")).toBeNull();
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

describe("NotificationThread visual treatment", () => {
  it("wraps grouped threads with a 2px tint left rail", async () => {
    const correlationId = "thread-rail";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "rail-entry-1",
        type: "info",
        message: "Step 1",
        correlationId,
        timestamp: Date.now() - 2000,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "rail-entry-2",
        type: "info",
        message: "Step 2",
        correlationId,
        timestamp: Date.now() - 1000,
      })
    );

    render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Step 2")).toBeTruthy();
    });

    const wrapper = screen.getByTestId("notification-thread");
    expect(wrapper.className).toMatch(/border-l-2/);
    expect(wrapper.className).toMatch(/border-tint\//);
    expect(wrapper.className).not.toMatch(/border-daintree-accent/);
    expect(wrapper.className).not.toMatch(/bg-daintree-accent/);
  });

  it("does not render the thread rail wrapper for solo entries", async () => {
    setEntries([makeEntry({ message: "Solo" })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Solo")).toBeTruthy();
    });

    expect(screen.queryByTestId("notification-thread")).toBeNull();
  });
});

describe("NotificationThread — dismiss removes entire thread", () => {
  it("removes all entries in a multi-entry thread with one X click", async () => {
    const correlationId = "thread-dismiss";
    useNotificationHistoryStore.getState().addEntry({
      ...makeEntry({
        id: "first",
        type: "info",
        message: "Build failed",
        correlationId,
        timestamp: Date.now() - 2000,
      }),
      seenAsToast: true,
    });
    useNotificationHistoryStore.getState().addEntry({
      ...makeEntry({
        id: "second",
        type: "info",
        message: "Build retried",
        correlationId,
        timestamp: Date.now() - 1000,
      }),
      seenAsToast: true,
    });

    render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("notification-thread")).toBeTruthy();
    });

    const thread = screen.getByTestId("notification-thread");
    const dismissButton = within(thread).getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(screen.queryByTestId("notification-thread")).toBeNull();
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
  });

  it("does not remove entries with a different correlationId", async () => {
    const correlationId = "thread-dismiss-2";
    useNotificationHistoryStore.getState().addEntry({
      ...makeEntry({
        id: "first",
        type: "info",
        message: "Build failed",
        correlationId,
        timestamp: Date.now() - 2000,
      }),
      seenAsToast: true,
    });
    useNotificationHistoryStore.getState().addEntry({
      ...makeEntry({
        id: "second",
        type: "info",
        message: "Build retried",
        correlationId,
        timestamp: Date.now() - 1000,
      }),
      seenAsToast: true,
    });
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "solo",
        type: "info",
        message: "Unrelated notification",
      })
    );

    render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("notification-thread")).toBeTruthy();
    });

    const thread = screen.getByTestId("notification-thread");
    const dismissButton = within(thread).getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(screen.queryByTestId("notification-thread")).toBeNull();
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
    expect(useNotificationHistoryStore.getState().entries[0]!.message).toBe(
      "Unrelated notification"
    );
  });

  it("updates unreadCount correctly when thread entries are dismissed", async () => {
    const correlationId = "thread-dismiss-3";
    useNotificationHistoryStore.getState().addEntry({
      ...makeEntry({
        type: "info",
        message: "Error 1",
        correlationId,
      }),
      seenAsToast: false,
    });
    useNotificationHistoryStore.getState().addEntry({
      ...makeEntry({
        id: "test-2",
        type: "info",
        message: "Error 2",
        correlationId,
      }),
      seenAsToast: true,
    });

    expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);

    render(<NotificationCenter open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("notification-thread")).toBeTruthy();
    });

    const thread = screen.getByTestId("notification-thread");
    const dismissButton = within(thread).getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
  });
});

describe("NotificationCenter empty state — zero data", () => {
  it("renders a description that explains where notifications appear", () => {
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByText(/Notifications appear here/)).toBeTruthy();
  });

  it("renders 'Notification settings' as a clickable link inline in the description", async () => {
    const onClose = vi.fn();
    render(<NotificationCenter open onClose={onClose} />);

    const link = screen.getByRole("button", { name: "Notification settings" });
    expect(link).toBeTruthy();
    expect(link.tagName).toBe("BUTTON");

    await act(async () => {
      fireEvent.click(link);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "notifications" },
      { source: "user" }
    );
  });

  it("does not render the description on the user-cleared empty state", async () => {
    setEntries([makeEntry({ seenAsToast: true })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const unreadButton = screen.getByText("Unread");
    await act(async () => {
      fireEvent.click(unreadButton);
    });

    expect(screen.getByText("You're all caught up")).toBeTruthy();
    expect(screen.queryByText(/Notifications appear here/)).toBeNull();
  });
});

describe("NotificationCenter empty state — muted", () => {
  it("renders the muted empty state with a 'Resuming at' description when session mute is active and inbox is empty", () => {
    const until = Date.now() + 60 * 60 * 1000;
    useNotificationSettingsStore.setState({ quietUntil: until });

    render(<NotificationCenter open onClose={vi.fn()} />);

    const emptyState = screen.getByTestId("notification-muted-empty-state");
    expect(emptyState).toBeTruthy();
    expect(within(emptyState).getByText("Notifications paused")).toBeTruthy();
    expect(emptyState.textContent).toMatch(/Resuming at /);
    expect(emptyState.textContent).not.toMatch(/Quiet hours active/);
    expect(screen.queryByText("No notifications yet")).toBeNull();
    expect(screen.queryByText(/Notifications appear here/)).toBeNull();
    // No duplicate Resume affordance inside the empty state — header pill owns it.
    expect(within(emptyState).queryByLabelText("Resume notifications")).toBeNull();
  });

  it("renders the muted empty state with 'Quiet hours active' provenance when only scheduled quiet hours are active", () => {
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

      render(<NotificationCenter open onClose={vi.fn()} />);

      const emptyState = screen.getByTestId("notification-muted-empty-state");
      expect(within(emptyState).getByText("Notifications paused")).toBeTruthy();
      expect(emptyState.textContent).toMatch(/Quiet hours active\. Resuming at /);
      expect(screen.queryByText("No notifications yet")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the scheduled quiet-hours end time when both session and scheduled mutes overlap and scheduled ends later", () => {
    const fixedNow = new Date();
    fixedNow.setHours(2, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      // Session expires at 03:00, scheduled quiet hours end at 08:00 — notifications
      // do not actually resume until 08:00, so the body must show that.
      useNotificationSettingsStore.setState({
        quietUntil: fixedNow.getTime() + 60 * 60 * 1000,
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 8 * 60,
        quietHoursWeekdays: [],
      });

      render(<NotificationCenter open onClose={vi.fn()} />);

      const emptyState = screen.getByTestId("notification-muted-empty-state");
      expect(emptyState.textContent).toMatch(/Quiet hours active\. Resuming at /);
      // Must not advertise the earlier (session) resume time.
      const formatted = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(fixedNow.getTime() + 60 * 60 * 1000));
      expect(emptyState.textContent).not.toContain(formatted);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls through to the zero-data empty state when scheduled quiet hours are enabled but the current time is outside the window", () => {
    const fixedNow = new Date();
    fixedNow.setHours(12, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 8 * 60,
        quietHoursWeekdays: [],
      });

      render(<NotificationCenter open onClose={vi.fn()} />);

      expect(screen.queryByTestId("notification-muted-empty-state")).toBeNull();
      expect(screen.getByText("No notifications yet")).toBeTruthy();
      expect(screen.getByText(/Notifications appear here/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the user-cleared empty state over the muted empty state when filter=unread and entries exist", async () => {
    const until = Date.now() + 60 * 60 * 1000;
    useNotificationSettingsStore.setState({ quietUntil: until });
    setEntries([makeEntry({ seenAsToast: true })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const unreadButton = screen.getByText("Unread");
    await act(async () => {
      fireEvent.click(unreadButton);
    });

    expect(screen.getByText("You're all caught up")).toBeTruthy();
    expect(screen.queryByTestId("notification-muted-empty-state")).toBeNull();
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

describe("NotificationCenter — Needs attention pinned section", () => {
  it("does not render the section when there are no unread error/warning entries", () => {
    setEntries([
      makeEntry({ type: "info", message: "An info", seenAsToast: false }),
      makeEntry({ id: "entry-99", type: "success", message: "A success", seenAsToast: false }),
    ]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByTestId("needs-attention-section")).toBeNull();
  });

  it("does not render the section when severe entries are already read", () => {
    setEntries([
      makeEntry({ type: "error", message: "Old failure", seenAsToast: true }),
      makeEntry({ id: "entry-2", type: "warning", message: "Old warning", seenAsToast: true }),
    ]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByTestId("needs-attention-section")).toBeNull();
  });

  it("renders the pinned section above chrono with one unread error", () => {
    setEntries([makeEntry({ type: "error", message: "Build failed", seenAsToast: false })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const pinned = screen.getByTestId("needs-attention-section");
    const chrono = screen.getByTestId("chrono-section");
    expect(within(pinned).getByText("Needs attention")).toBeTruthy();
    expect(within(pinned).queryAllByText("Build failed").length).toBe(1);
    expect(within(chrono).queryAllByText("Build failed").length).toBe(1);
    // Pinned section comes before chrono section in DOM order.
    const position = pinned.compareDocumentPosition(chrono);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("caps the pinned section at 5 entries even when more unread severe entries exist", () => {
    const baseT = Date.now();
    const items = Array.from({ length: 7 }, (_, i) =>
      makeEntry({
        id: `failure-${i}`,
        type: "error",
        message: `Failure ${i}`,
        timestamp: baseT - i,
        seenAsToast: false,
      })
    );
    setEntries(items);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const pinned = screen.getByTestId("needs-attention-section");
    const messages = within(pinned).getAllByText(/^Failure \d$/);
    expect(messages).toHaveLength(5);
  });

  it("stays consistent across All and Unread filter views for mixed read/unread threads", async () => {
    const correlationId = "thread-mixed";
    const t = Date.now();
    setEntries([
      // Newest first per store convention.
      makeEntry({
        id: "info-followup",
        type: "info",
        message: "Followup info",
        correlationId,
        timestamp: t + 1000,
        seenAsToast: false,
      }),
      makeEntry({
        id: "old-error",
        type: "error",
        message: "Old failure",
        correlationId,
        timestamp: t,
        seenAsToast: true,
      }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    expect(screen.queryByTestId("needs-attention-section")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Unread"));
    });

    // Pinned section uses raw entries — same group qualifies in both views.
    expect(screen.queryByTestId("needs-attention-section")).toBeTruthy();
  });

  it("sorts pinned entries by severity (error before warning) then by recency", () => {
    const t = Date.now();
    setEntries([
      makeEntry({
        id: "newer-warn",
        type: "warning",
        message: "Newer warning",
        timestamp: t + 10,
        seenAsToast: false,
      }),
      makeEntry({
        id: "newer-err",
        type: "error",
        message: "Newer error",
        timestamp: t + 5,
        seenAsToast: false,
      }),
      makeEntry({
        id: "older-warn",
        type: "warning",
        message: "Old warning",
        timestamp: t,
        seenAsToast: false,
      }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const pinned = screen.getByTestId("needs-attention-section");
    const messages = within(pinned).getAllByText(/^(Newer|Old) (error|warning)$/);
    // Error first (severity 3), then newer warning, then older warning (sev 2 by recency).
    expect(messages.map((n) => n.textContent)).toEqual([
      "Newer error",
      "Newer warning",
      "Old warning",
    ]);
  });
});

describe("NotificationCenter — Group by context toggle", () => {
  it("does not render the toggle when there are no entries", () => {
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByLabelText("Group by project or worktree")).toBeNull();
  });

  it("renders the toggle when entries exist", () => {
    setEntries([makeEntry()]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByLabelText("Group by project or worktree")).toBeTruthy();
  });

  it("clicking the toggle flips groupByContext optimistically", async () => {
    setEntries([makeEntry()]);
    render(<NotificationCenter open onClose={vi.fn()} />);

    const toggle = screen.getByLabelText("Group by project or worktree");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(useNotificationSettingsStore.getState().groupByContext).toBe(true);
    expect(screen.getByLabelText("Group by project or worktree").getAttribute("aria-pressed")).toBe(
      "true"
    );
  });

  it("carries an off-state border outline that flips to transparent when pressed", async () => {
    setEntries([makeEntry()]);
    render(<NotificationCenter open onClose={vi.fn()} />);

    const toggle = screen.getByLabelText("Group by project or worktree");
    expect(toggle.className).toContain("border");
    expect(toggle.className).toContain("border-daintree-text/15");
    expect(toggle.className).not.toContain("border-transparent");

    await act(async () => {
      fireEvent.click(toggle);
    });

    const pressed = screen.getByLabelText("Group by project or worktree");
    expect(pressed.className).toContain("border-transparent");
    expect(pressed.className).not.toContain("border-daintree-text/15");
  });

  it("starts in on-state with border-transparent and flips to /15 outline when toggled off", async () => {
    useNotificationSettingsStore.setState({ groupByContext: true });
    setEntries([makeEntry()]);
    render(<NotificationCenter open onClose={vi.fn()} />);

    const toggle = screen.getByLabelText("Group by project or worktree");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.className).toContain("border-transparent");
    expect(toggle.className).not.toContain("border-daintree-text/15");

    await act(async () => {
      fireEvent.click(toggle);
    });

    const released = screen.getByLabelText("Group by project or worktree");
    expect(released.getAttribute("aria-pressed")).toBe("false");
    expect(released.className).toContain("border-daintree-text/15");
    expect(released.className).not.toContain("border-transparent");
  });

  it("renders context section headers with worktree names when groupByContext is on", () => {
    worktreeStoreMock.worktrees.set("wt-1", { worktreeId: "wt-1", name: "feature/login" });
    worktreeStoreMock.worktrees.set("wt-2", { worktreeId: "wt-2", name: "feature/billing" });
    useNotificationSettingsStore.setState({ groupByContext: true });
    setEntries([
      makeEntry({ message: "Login msg", context: { worktreeId: "wt-1" } }),
      makeEntry({ id: "entry-99", message: "Billing msg", context: { worktreeId: "wt-2" } }),
      makeEntry({
        id: "entry-100",
        message: "Stray msg",
        context: { projectId: "proj-x" },
      }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const headers = screen.getAllByTestId("context-section-header");
    expect(headers.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("feature/login")])
    );
    expect(headers.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("feature/billing")])
    );
    // Falls back to projectId when worktreeId is absent.
    expect(headers.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("proj-x")])
    );
  });

  it("falls back to raw worktreeId when no name is registered", () => {
    useNotificationSettingsStore.setState({ groupByContext: true });
    setEntries([makeEntry({ message: "Stray", context: { worktreeId: "wt-unknown" } })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    // No worktree mock entry → falls through to raw worktreeId for disambiguation.
    const header = screen.getByTestId("context-section-header");
    expect(header.textContent).toContain("wt-unknown");
  });

  it("falls back to 'Other' only when the entry has no worktreeId or projectId", () => {
    useNotificationSettingsStore.setState({ groupByContext: true });
    setEntries([makeEntry({ message: "Contextless" })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const header = screen.getByTestId("context-section-header");
    expect(header.textContent).toContain("Other");
  });

  it("renders distinct context sections for two unknown worktrees (no merge into one 'Other')", () => {
    useNotificationSettingsStore.setState({ groupByContext: true });
    setEntries([
      makeEntry({ id: "e1", message: "msg-1", context: { worktreeId: "wt-aaa" } }),
      makeEntry({ id: "e2", message: "msg-2", context: { worktreeId: "wt-bbb" } }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const headers = screen.getAllByTestId("context-section-header");
    expect(headers).toHaveLength(2);
    const labels = headers.map((h) => h.textContent ?? "");
    expect(labels.some((l) => l.includes("wt-aaa"))).toBe(true);
    expect(labels.some((l) => l.includes("wt-bbb"))).toBe(true);
  });

  it("does not render context headers when groupByContext is off", () => {
    setEntries([
      makeEntry({ message: "msg-1", context: { worktreeId: "wt-1" } }),
      makeEntry({ id: "entry-99", message: "msg-2", context: { worktreeId: "wt-2" } }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    expect(screen.queryByTestId("context-section-header")).toBeNull();
  });
});

describe("NotificationCenter — Filter inactive contrast", () => {
  it("uses /60 on inactive pills, matching the QuickStateFilterBar pattern", () => {
    setEntries([makeEntry({ message: "msg-1" })]);
    render(<NotificationCenter open onClose={vi.fn()} />);

    // Filter starts on "All" → "Unread" is the inactive segment.
    const unread = screen.getByText("Unread");
    expect(unread.className).toContain("text-daintree-text/60");
    expect(unread.className).not.toContain("text-daintree-text/40");
    expect(unread.className).toContain("hover:text-daintree-text");

    fireEvent.click(unread);

    // After flipping, "All" is the inactive segment.
    const all = screen.getByText("All");
    expect(all.className).toContain("text-daintree-text/60");
    expect(all.className).not.toContain("text-daintree-text/40");
    expect(all.className).toContain("hover:text-daintree-text");
  });

  it("does not render either segment when entries is empty", () => {
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByText("All")).toBeNull();
    expect(screen.queryByText("Unread")).toBeNull();
  });
});

describe("NotificationCenter — New since you last looked divider", () => {
  it("does not render when lastClosedAt is 0 (cold session)", () => {
    setEntries([makeEntry({ message: "Recent msg" })]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByTestId("new-since-last-looked")).toBeNull();
  });

  it("does not render when no entry is newer than lastClosedAt", () => {
    const olderTs = Date.now() - 10_000;
    setEntries([makeEntry({ message: "Old msg", timestamp: olderTs })]);
    useUIStore.setState({ lastNotificationCenterClosedAt: Date.now() });
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByTestId("new-since-last-looked")).toBeNull();
  });

  it("renders the divider above the first entry whose timestamp is newer than lastClosedAt", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([
      makeEntry({ message: "Newer 1", timestamp: closedAt + 4000 }),
      makeEntry({ id: "entry-99", message: "Newer 2", timestamp: closedAt + 3000 }),
      makeEntry({ id: "entry-100", message: "Older", timestamp: closedAt - 1000 }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    expect(screen.queryByTestId("new-since-last-looked")).toBeTruthy();
  });

  it("clears the divider when 'Mark all read' is clicked", async () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "Newer",
    });

    render(<NotificationCenter open onClose={vi.fn()} />);

    expect(screen.queryByTestId("new-since-last-looked")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Mark all read"));
    });

    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBe(0);
    expect(screen.queryByTestId("new-since-last-looked")).toBeNull();
  });
});

describe("NotificationCenter — bulk mark-read with Undo", () => {
  function getLastNotifyPayload() {
    const calls = vi.mocked(notifyLib.notify).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1]![0];
  }

  it("'Mark all read' marks every unread entry and emits an undo toast", async () => {
    setEntries([
      makeEntry({ id: "u1", message: "Unread 1", seenAsToast: false }),
      makeEntry({ id: "u2", message: "Unread 2", seenAsToast: false }),
      makeEntry({ id: "r1", message: "Already read", seenAsToast: true }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Mark all read"));
    });

    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);

    const payload = getLastNotifyPayload();
    expect(payload.type).toBe("success");
    expect(payload.message).toBe("Marked 2 as read");
    expect(payload.duration).toBe(5000);
    expect(payload.urgent).toBe(true);
    expect(payload.transient).toBe(true);
    expect(payload.priority).toBe("high");
    expect(payload.context).toBeUndefined();
    expect(payload.action?.label).toBe("Undo");
  });

  it("'Mark all read' resets lastNotificationCenterClosedAt to clear the divider", async () => {
    useUIStore.setState({ lastNotificationCenterClosedAt: 12345 });
    setEntries([makeEntry({ message: "Unread", seenAsToast: false })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Mark all read"));
    });

    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBe(0);
  });

  it("undo restores the captured ids back to unread", async () => {
    setEntries([
      makeEntry({ id: "u1", message: "Unread 1", seenAsToast: false }),
      makeEntry({ id: "u2", message: "Unread 2", seenAsToast: false }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Mark all read"));
    });
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);

    const payload = getLastNotifyPayload();
    await act(async () => {
      payload.action?.onClick?.();
    });

    expect(useNotificationHistoryStore.getState().unreadCount).toBe(2);
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === "u1")?.seenAsToast).toBe(false);
    expect(entries.find((e) => e.id === "u2")?.seenAsToast).toBe(false);
  });

  it("undo does not increment evictedToInboxCount (silent restore)", async () => {
    setEntries([makeEntry({ message: "Unread", seenAsToast: false })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Mark all read"));
    });

    const payload = getLastNotifyPayload();
    await act(async () => {
      payload.action?.onClick?.();
    });

    expect(useNotificationHistoryStore.getState().evictedToInboxCount).toBe(0);
  });

  it("does nothing and emits no toast when there are no unread entries", () => {
    setEntries([makeEntry({ message: "Read", seenAsToast: true })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    // The "Mark all read" button only renders when unreadCount > 0.
    expect(screen.queryByText("Mark all read")).toBeNull();
    expect(vi.mocked(notifyLib.notify)).not.toHaveBeenCalled();
  });

  it("'Mark these N read' on the divider marks only entries above the divider", async () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([
      makeEntry({
        id: "new-1",
        message: "Newer 1",
        timestamp: closedAt + 4000,
        seenAsToast: false,
      }),
      makeEntry({
        id: "new-2",
        message: "Newer 2",
        timestamp: closedAt + 3000,
        seenAsToast: false,
      }),
      makeEntry({
        id: "old-1",
        message: "Older",
        timestamp: closedAt - 1000,
        seenAsToast: false,
      }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    expect(screen.queryByTestId("new-since-last-looked")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Mark these 2 read"));
    });

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === "new-1")?.seenAsToast).toBe(true);
    expect(entries.find((e) => e.id === "new-2")?.seenAsToast).toBe(true);
    expect(entries.find((e) => e.id === "old-1")?.seenAsToast).toBe(false);

    const payload = getLastNotifyPayload();
    expect(payload.message).toBe("Marked 2 as read");
    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBe(0);
  });

  it("section 'Mark read' marks only the section's unread entries and does NOT reset lastClosedAt", async () => {
    worktreeStoreMock.worktrees.set("wt-1", { worktreeId: "wt-1", name: "feature/login" });
    worktreeStoreMock.worktrees.set("wt-2", { worktreeId: "wt-2", name: "feature/billing" });
    useNotificationSettingsStore.setState({ groupByContext: true });
    useUIStore.setState({ lastNotificationCenterClosedAt: 99999 });
    setEntries([
      makeEntry({
        id: "wt1-1",
        message: "Login msg 1",
        seenAsToast: false,
        context: { worktreeId: "wt-1" },
      }),
      makeEntry({
        id: "wt1-2",
        message: "Login msg 2",
        seenAsToast: false,
        context: { worktreeId: "wt-1" },
      }),
      makeEntry({
        id: "wt2-1",
        message: "Billing msg",
        seenAsToast: false,
        context: { worktreeId: "wt-2" },
      }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const headers = screen.getAllByTestId("context-section-header");
    const loginHeader = headers.find((h) => (h.textContent ?? "").includes("feature/login"));
    expect(loginHeader).toBeTruthy();

    // Mark read button is always visible (not gated on hover).
    const markReadBtn = within(loginHeader!).getByText("Mark read");
    expect(markReadBtn.className).not.toContain("invisible");

    await act(async () => {
      fireEvent.click(markReadBtn);
    });

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === "wt1-1")?.seenAsToast).toBe(true);
    expect(entries.find((e) => e.id === "wt1-2")?.seenAsToast).toBe(true);
    expect(entries.find((e) => e.id === "wt2-1")?.seenAsToast).toBe(false);

    // Section "Mark read" must NOT reset the divider — only header + divider do.
    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBe(99999);

    const payload = getLastNotifyPayload();
    expect(payload.message).toBe("Marked 2 as read");
  });

  it("section header 'Mark read' button is not rendered when the section has no unread entries", () => {
    worktreeStoreMock.worktrees.set("wt-1", { worktreeId: "wt-1", name: "feature/login" });
    useNotificationSettingsStore.setState({ groupByContext: true });
    setEntries([
      makeEntry({
        id: "wt1-1",
        message: "All read",
        seenAsToast: true,
        context: { worktreeId: "wt-1" },
      }),
    ]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const header = screen.getByTestId("context-section-header");
    expect(within(header).queryByText("Mark read")).toBeNull();
  });
});

describe("NotificationCenter — Jump to new pill", () => {
  type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;
  const observers: { cb: ObserverCallback; targets: Element[]; root: Element | null }[] = [];

  function fireObserver(
    rootBounds: { top: number; bottom: number; left: number; right: number },
    targetTop: number,
    isIntersecting: boolean
  ) {
    for (const o of observers) {
      for (const target of o.targets) {
        o.cb([
          {
            isIntersecting,
            boundingClientRect: {
              top: targetTop,
              bottom: targetTop + 16,
              left: 0,
              right: 100,
              width: 100,
              height: 16,
              x: 0,
              y: targetTop,
              toJSON() {
                return this;
              },
            } as DOMRectReadOnly,
            rootBounds: {
              top: rootBounds.top,
              bottom: rootBounds.bottom,
              left: rootBounds.left,
              right: rootBounds.right,
              width: rootBounds.right - rootBounds.left,
              height: rootBounds.bottom - rootBounds.top,
              x: rootBounds.left,
              y: rootBounds.top,
              toJSON() {
                return this;
              },
            } as DOMRectReadOnly,
            intersectionRatio: isIntersecting ? 1 : 0,
            intersectionRect: {} as DOMRectReadOnly,
            target,
            time: Date.now(),
          } as IntersectionObserverEntry,
        ]);
      }
    }
  }

  beforeEach(() => {
    observers.length = 0;
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null;
      readonly rootMargin: string = "0px";
      readonly thresholds: ReadonlyArray<number> = [0];
      private targets: Element[] = [];
      constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
        this.root = (options?.root as Element | null) ?? null;
        observers.push({ cb: callback, targets: this.targets, root: this.root as Element | null });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      unobserve(target: Element) {
        const idx = this.targets.indexOf(target);
        if (idx >= 0) this.targets.splice(idx, 1);
      }
      disconnect() {
        const idx = observers.findIndex((o) => o.targets === this.targets);
        if (idx >= 0) observers.splice(idx, 1);
        this.targets.length = 0;
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  it("does not render when there is no unread divider (cold session)", () => {
    setEntries([makeEntry({ message: "Old msg" })]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByTestId("jump-to-new-pill")).toBeNull();
  });

  it("renders pill (hidden) when divider exists and is initially visible", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    render(<NotificationCenter open onClose={vi.fn()} />);
    const pill = screen.getByTestId("jump-to-new-pill");
    expect(pill).toBeTruthy();
    expect(pill.className).toMatch(/opacity-0/);
    expect(pill.className).toMatch(/pointer-events-none/);
  });

  it("becomes visible when divider scrolls below the viewport", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    act(() => {
      fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, 500, false);
    });

    const pill = screen.getByTestId("jump-to-new-pill");
    expect(pill.className).toMatch(/opacity-100/);
    expect(pill.className).toMatch(/pointer-events-auto/);
  });

  it("stays hidden when divider scrolls above the viewport", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    act(() => {
      fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, -50, false);
    });

    const pill = screen.getByTestId("jump-to-new-pill");
    expect(pill.className).toMatch(/opacity-0/);
  });

  it("hides again when divider returns to the viewport", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    act(() => {
      fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, 500, false);
    });
    expect(screen.getByTestId("jump-to-new-pill").className).toMatch(/opacity-100/);

    act(() => {
      fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, 100, true);
    });
    expect(screen.getByTestId("jump-to-new-pill").className).toMatch(/opacity-0/);
  });

  it("announces 'New notifications below' when pill becomes visible", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    expect(useAnnouncerStore.getState().polite).toBeNull();

    act(() => {
      fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, 500, false);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("New notifications below");
  });

  it("clicking the pill calls scrollIntoView and focus on the divider", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    const proto = HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => void;
    };
    const originalScroll = proto.scrollIntoView;
    const scrollSpy = vi.fn();
    proto.scrollIntoView = scrollSpy;

    try {
      render(<NotificationCenter open onClose={vi.fn()} />);

      const divider = screen.getByTestId("new-since-last-looked");
      const focusSpy = vi.spyOn(divider, "focus").mockImplementation(() => undefined);

      act(() => {
        fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, 500, false);
      });

      fireEvent.click(screen.getByTestId("jump-to-new-pill"));

      expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
      expect(focusSpy).toHaveBeenCalled();
    } finally {
      proto.scrollIntoView = originalScroll;
    }
  });

  it("does not auto-scroll when the panel opens (no scrollIntoView on mount)", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    const proto = HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => void;
    };
    const original = proto.scrollIntoView;
    const spy = vi.fn();
    proto.scrollIntoView = spy;
    try {
      render(<NotificationCenter open onClose={vi.fn()} />);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it("hidden pill is aria-hidden and not focusable; visible pill is reachable", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const pill = screen.getByTestId("jump-to-new-pill");
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    expect(pill.getAttribute("tabindex")).toBe("-1");

    act(() => {
      fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, 500, false);
    });

    expect(pill.getAttribute("aria-hidden")).toBeNull();
    expect(pill.getAttribute("tabindex")).toBe("0");
  });

  it("uses Tier 2 timing — 200ms enter, 120ms exit", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    render(<NotificationCenter open onClose={vi.fn()} />);

    const pill = screen.getByTestId("jump-to-new-pill") as HTMLButtonElement;
    expect(pill.style.transitionDuration).toBe("120ms");

    act(() => {
      fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, 500, false);
    });
    expect(pill.style.transitionDuration).toBe("200ms");

    act(() => {
      fireObserver({ top: 0, bottom: 400, left: 0, right: 360 }, 100, true);
    });
    expect(pill.style.transitionDuration).toBe("120ms");
  });

  it("observer's root is the scroll container (not the popover or document)", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);

    expect(observers.length).toBeGreaterThan(0);
    const root = observers[observers.length - 1]!.root;
    expect(root).not.toBeNull();
    const scrollDiv = container.querySelector(".overflow-y-auto");
    expect(scrollDiv).not.toBeNull();
    expect(root).toBe(scrollDiv);
  });

  it("disconnects the observer on unmount", () => {
    const closedAt = Date.now() - 5000;
    useUIStore.setState({ lastNotificationCenterClosedAt: closedAt });
    setEntries([makeEntry({ message: "Newer", timestamp: closedAt + 4000 })]);

    const { unmount } = render(<NotificationCenter open onClose={vi.fn()} />);
    expect(observers.length).toBeGreaterThan(0);

    unmount();
    expect(observers.length).toBe(0);
  });
});

describe("NotificationCenter — Thread title weight reflects unread state", () => {
  it("renders thread title with font-semibold when any entry is unread", async () => {
    const correlationId = "thread-mixed";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "thread-old",
        type: "info",
        title: "Mixed thread",
        message: "First message",
        correlationId,
        timestamp: Date.now() - 2000,
        seenAsToast: false,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "thread-latest",
        type: "info",
        title: "Mixed thread",
        message: "Latest message",
        correlationId,
        timestamp: Date.now() - 1000,
        seenAsToast: true,
      })
    );

    render(<NotificationCenter open onClose={vi.fn()} />);

    const titleEls = await screen.findAllByText("Mixed thread");
    expect(titleEls[0]!.className).toMatch(/font-semibold/);
    expect(titleEls[0]!.className).not.toMatch(/font-medium/);
  });

  it("renders thread title with font-normal when all entries are read", async () => {
    const correlationId = "thread-all-read";
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "read-1",
        type: "info",
        title: "Quiet thread",
        message: "First",
        correlationId,
        timestamp: Date.now() - 2000,
        seenAsToast: true,
      })
    );
    useNotificationHistoryStore.getState().addEntry(
      makeEntry({
        id: "read-2",
        type: "info",
        title: "Quiet thread",
        message: "Second",
        correlationId,
        timestamp: Date.now() - 1000,
        seenAsToast: true,
      })
    );

    render(<NotificationCenter open onClose={vi.fn()} />);

    const titleEls = await screen.findAllByText("Quiet thread");
    expect(titleEls[0]!.className).toMatch(/font-normal/);
  });
});

describe("uiStore — closeNotificationCenter records timestamp", () => {
  it("sets lastNotificationCenterClosedAt to Date.now() when closing", () => {
    useUIStore.setState({ notificationCenterOpen: true, lastNotificationCenterClosedAt: 0 });
    const before = Date.now();
    useUIStore.getState().closeNotificationCenter();
    const after = Date.now();
    expect(useUIStore.getState().notificationCenterOpen).toBe(false);
    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBeGreaterThanOrEqual(before);
    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBeLessThanOrEqual(after);
  });

  it("does not change the timestamp when already closed", () => {
    useUIStore.setState({
      notificationCenterOpen: false,
      lastNotificationCenterClosedAt: 12345,
    });
    useUIStore.getState().closeNotificationCenter();
    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBe(12345);
  });

  it("toggleNotificationCenter records timestamp only on closing transition", () => {
    useUIStore.setState({ notificationCenterOpen: false, lastNotificationCenterClosedAt: 0 });
    useUIStore.getState().toggleNotificationCenter();
    expect(useUIStore.getState().notificationCenterOpen).toBe(true);
    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBe(0);

    useUIStore.getState().toggleNotificationCenter();
    expect(useUIStore.getState().notificationCenterOpen).toBe(false);
    expect(useUIStore.getState().lastNotificationCenterClosedAt).toBeGreaterThan(0);
  });
});

describe("NotificationCenter — keyboard navigation", () => {
  function getRows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]'));
  }

  it("marks the scroll container as role=list with an aria-label", () => {
    setEntries([
      makeEntry({ id: "row-a", message: "First" }),
      makeEntry({ id: "row-b", message: "Second" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"][aria-label="Notifications"]');
    expect(list).not.toBeNull();
  });

  it("does not mark the container as a list when there are no rows", () => {
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    expect(container.querySelector('[role="list"]')).toBeNull();
  });

  it("renders the first row with tabIndex=0 and the rest with tabIndex=-1", () => {
    setEntries([
      makeEntry({ id: "a", message: "First" }),
      makeEntry({ id: "b", message: "Second" }),
      makeEntry({ id: "c", message: "Third" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const rows = getRows(container);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute("tabindex")).toBe("0");
    expect(rows[1]?.getAttribute("tabindex")).toBe("-1");
    expect(rows[2]?.getAttribute("tabindex")).toBe("-1");
  });

  it("moves the roving focus to the next row on j and ArrowDown", () => {
    setEntries([
      makeEntry({ id: "a", message: "First" }),
      makeEntry({ id: "b", message: "Second" }),
      makeEntry({ id: "c", message: "Third" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const rows = getRows(container);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      rows[0]?.focus();
    });
    fireEvent.keyDown(list, { key: "j" });
    expect(getRows(container)[1]?.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(getRows(container)[1]);

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(getRows(container)[2]?.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(getRows(container)[2]);
  });

  it("moves the roving focus to the previous row on k and ArrowUp", () => {
    setEntries([
      makeEntry({ id: "a", message: "First" }),
      makeEntry({ id: "b", message: "Second" }),
      makeEntry({ id: "c", message: "Third" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;
    const lastRow = getRows(container)[2]!;

    act(() => {
      lastRow.focus();
    });
    fireEvent.keyDown(list, { key: "k" });
    expect(document.activeElement).toBe(getRows(container)[1]);

    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement).toBe(getRows(container)[0]);
  });

  it("clamps at the last row instead of wrapping", () => {
    setEntries([makeEntry({ id: "a" }), makeEntry({ id: "b" })]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[1]?.focus();
    });
    fireEvent.keyDown(list, { key: "j" });
    expect(document.activeElement).toBe(getRows(container)[1]);
  });

  it("clamps at the first row instead of wrapping", () => {
    setEntries([makeEntry({ id: "a" }), makeEntry({ id: "b" })]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[0]?.focus();
    });
    fireEvent.keyDown(list, { key: "k" });
    expect(document.activeElement).toBe(getRows(container)[0]);
  });

  it("Home jumps to the first row and End to the last", () => {
    setEntries([
      makeEntry({ id: "a" }),
      makeEntry({ id: "b" }),
      makeEntry({ id: "c" }),
      makeEntry({ id: "d" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[0]?.focus();
    });
    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(getRows(container)[3]);

    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(getRows(container)[0]);
  });

  it("does nothing when focus is outside the row set", () => {
    setEntries([makeEntry({ id: "a" }), makeEntry({ id: "b" })]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    // No row is focused — j must be a no-op.
    expect(document.activeElement).not.toBe(getRows(container)[0]);
    fireEvent.keyDown(list, { key: "j" });
    expect(getRows(container)[0]?.getAttribute("tabindex")).toBe("0");
    expect(getRows(container)[1]?.getAttribute("tabindex")).toBe("-1");
  });

  it("dismisses the focused row on 'e' and clamps focus to the new last row", async () => {
    setEntries([
      makeEntry({ id: "a", message: "First" }),
      makeEntry({ id: "b", message: "Second" }),
      makeEntry({ id: "c", message: "Last to remove" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[2]?.focus();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "e" });
    });

    await waitFor(() => {
      expect(getRows(container)).toHaveLength(2);
    });
    expect(screen.queryByText("Last to remove")).toBeNull();
    // After the last row is removed, the clamping effect drops focusedIndex to 1.
    expect(getRows(container)[1]?.getAttribute("tabindex")).toBe("0");
  });

  it("dispatches the focused row's primary action on Enter", async () => {
    getMock.mockReturnValue({ enabled: true });
    setEntries([
      makeEntry({
        id: "a",
        message: "Has action",
        actions: [{ actionId: "test.action", label: "Open", actionArgs: { x: 1 } }],
      }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[0]?.focus();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "Enter" });
    });

    expect(dispatchMock).toHaveBeenCalledWith("test.action", { x: 1 });
  });

  it("does not dispatch on Enter when the action is unavailable", async () => {
    getMock.mockReturnValue({ enabled: false });
    setEntries([
      makeEntry({
        id: "a",
        message: "Disabled action",
        actions: [{ actionId: "test.action", label: "Open" }],
      }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[0]?.focus();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "Enter" });
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does not steal navigation keys while a row dropdown is open", () => {
    setEntries([
      makeEntry({ id: "a", context: { projectId: "p1" } }),
      makeEntry({ id: "b", context: { projectId: "p1" } }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;
    const rows = getRows(container);

    act(() => {
      rows[0]?.focus();
    });

    // Open the kebab menu on the first row — emulates Radix DropdownMenu open.
    const trigger = within(rows[0]!).getByLabelText("Notification options");
    act(() => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    // While the dropdown is open, j must NOT navigate.
    fireEvent.keyDown(list, { key: "j" });
    expect(getRows(container)[0]?.getAttribute("tabindex")).toBe("0");
    expect(getRows(container)[1]?.getAttribute("tabindex")).toBe("-1");
  });

  it("orders the flat row index across needs-attention and chrono sections", () => {
    setEntries([
      makeEntry({ id: "info-1", type: "info", message: "Info note", seenAsToast: true }),
      makeEntry({
        id: "err-1",
        type: "error",
        message: "Pinned error",
        seenAsToast: false,
      }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const rows = getRows(container);
    // Pinned needs-attention section comes first; it dedupes the entry from chrono not.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.getAttribute("tabindex")).toBe("0");
  });

  it("restores focus to the surviving row after dismissing the focused row via 'e'", async () => {
    setEntries([
      makeEntry({ id: "a", message: "Stay-1" }),
      makeEntry({ id: "b", message: "Stay-2" }),
      makeEntry({ id: "c", message: "Will go" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[2]?.focus();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "e" });
    });

    await waitFor(() => {
      expect(getRows(container)).toHaveLength(2);
    });
    // Focus must have followed to the new last surviving row, not dropped to <body>.
    expect(document.activeElement).toBe(getRows(container)[1]);
  });

  it("resumes navigation after the row dropdown is closed", async () => {
    setEntries([
      makeEntry({ id: "a", context: { projectId: "p1" } }),
      makeEntry({ id: "b", context: { projectId: "p1" } }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;
    const rows = getRows(container);

    act(() => {
      rows[0]?.focus();
    });

    const trigger = within(rows[0]!).getByLabelText("Notification options");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    // Close via Escape — Radix should fire onOpenChange(false).
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });

    // After the menu closes, j must navigate again.
    act(() => {
      getRows(container)[0]?.focus();
    });
    fireEvent.keyDown(list, { key: "j" });
    expect(document.activeElement).toBe(getRows(container)[1]);
  });

  it("recovers navigation after a focused-menu row is externally dismissed", async () => {
    setEntries([
      makeEntry({ id: "a", context: { projectId: "p1" } }),
      makeEntry({ id: "b" }),
      makeEntry({ id: "c" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;
    const rows = getRows(container);

    act(() => {
      rows[0]?.focus();
    });

    const trigger = within(rows[0]!).getByLabelText("Notification options");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
    });

    // External dismissal — bypass the kebab menu entirely. The dropdown
    // counter must reset so navigation isn't permanently stuck.
    await act(async () => {
      useNotificationHistoryStore.getState().dismissEntry("a");
    });

    await waitFor(() => {
      expect(getRows(container)).toHaveLength(2);
    });

    act(() => {
      getRows(container)[0]?.focus();
    });
    fireEvent.keyDown(list, { key: "j" });
    expect(document.activeElement).toBe(getRows(container)[1]);
  });

  it("does not navigate or dismiss when focus is on a descendant button inside the row", async () => {
    getMock.mockReturnValue({ enabled: true });
    setEntries([
      makeEntry({
        id: "a",
        message: "Has action",
        actions: [{ actionId: "test.action", label: "Open", actionArgs: { x: 1 } }],
      }),
      makeEntry({ id: "b", message: "Plain row" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    const actionButton = screen.getByText("Open");
    act(() => {
      actionButton.focus();
    });

    fireEvent.keyDown(list, { key: "j" });
    expect(document.activeElement).toBe(actionButton);

    fireEvent.keyDown(list, { key: "e" });
    expect(useNotificationHistoryStore.getState().entries.length).toBe(2);
  });
});

describe("archived tab and 'e' archive keybinding", () => {
  function getRows(container: HTMLElement) {
    return Array.from(container.querySelectorAll('[role="listitem"]')) as HTMLElement[];
  }

  it("'e' archives the focused row without destroying the entry", async () => {
    setEntries([
      makeEntry({ id: "a", message: "Keep" }),
      makeEntry({ id: "b", message: "Archive me" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[1]?.focus();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "e" });
    });

    // The All view filters archived entries out, so the row disappears.
    await waitFor(() => {
      expect(getRows(container)).toHaveLength(1);
    });
    // But the underlying entry survives — it moved to the Archived tab.
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries).toHaveLength(2);
    const archived = entries.find((e) => e.id === "b")!;
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.seenAsToast).toBe(true);
  });

  it("'e' on a thread archives every non-archived entry in the thread", async () => {
    setEntries([
      makeEntry({ id: "t1", message: "first", correlationId: "thread" }),
      makeEntry({ id: "t2", message: "second", correlationId: "thread" }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[0]?.focus();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "e" });
    });

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === "t1")!.archivedAt).not.toBeNull();
    expect(entries.find((e) => e.id === "t2")!.archivedAt).not.toBeNull();
  });

  it("All view hides archived entries", () => {
    setEntries([
      makeEntry({ id: "live", message: "Live entry" }),
      makeEntry({ id: "done", message: "Archived entry", archivedAt: Date.now() }),
    ]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByText("Live entry")).not.toBeNull();
    expect(screen.queryByText("Archived entry")).toBeNull();
  });

  it("Archived tab shows only archived entries", () => {
    setEntries([
      makeEntry({ id: "live", message: "Live entry" }),
      makeEntry({ id: "done", message: "Archived entry", archivedAt: Date.now() }),
    ]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.queryByText("Archived entry")).not.toBeNull();
    expect(screen.queryByText("Live entry")).toBeNull();
  });

  it("Unread tab hides archived entries", () => {
    setEntries([
      makeEntry({ id: "unread", message: "Unread live", seenAsToast: false }),
      makeEntry({
        id: "archived-unread",
        message: "Archived ignored",
        seenAsToast: false,
        archivedAt: Date.now(),
      }),
    ]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    expect(screen.queryByText("Unread live")).not.toBeNull();
    expect(screen.queryByText("Archived ignored")).toBeNull();
  });

  it("Archived tab does not render the Needs attention pinned section", () => {
    setEntries([
      makeEntry({
        id: "err",
        type: "error",
        message: "Pinned error",
        seenAsToast: false,
      }),
      makeEntry({
        id: "done",
        message: "Archived entry",
        archivedAt: Date.now(),
      }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    expect(container.querySelector('[data-testid="needs-attention-section"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(container.querySelector('[data-testid="needs-attention-section"]')).toBeNull();
  });

  it("Archived tab shows the empty state when no archived entries exist", () => {
    setEntries([makeEntry({ id: "live", message: "Live" })]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.queryByText("No archived notifications")).not.toBeNull();
  });

  it("'e' in the Archived tab permanently deletes the focused entry", async () => {
    setEntries([
      makeEntry({ id: "live", message: "Live entry" }),
      makeEntry({ id: "done", message: "Archived entry", archivedAt: Date.now() }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[0]?.focus();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "e" });
    });

    // Archived entry is gone from store entirely.
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === "done")).toBeUndefined();
    expect(entries.find((e) => e.id === "live")).not.toBeUndefined();
  });

  it("the Archived button is not rendered when there are zero entries", () => {
    setEntries([]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Archived" })).toBeNull();
  });

  it("'e' on an archived thread does not destroy live entries sharing the correlationId", async () => {
    setEntries([
      makeEntry({
        id: "live",
        message: "Active partner",
        correlationId: "panel-1",
        archivedAt: null,
        seenAsToast: false,
      }),
      makeEntry({
        id: "arch-a",
        message: "Done A",
        correlationId: "panel-1",
        archivedAt: Date.now(),
      }),
      makeEntry({
        id: "arch-b",
        message: "Done B",
        correlationId: "panel-1",
        archivedAt: Date.now(),
      }),
    ]);
    const { container } = render(<NotificationCenter open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    const list = container.querySelector('[role="list"]') as HTMLElement;

    act(() => {
      getRows(container)[0]?.focus();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "e" });
    });

    // The live entry must survive — pressing 'e' on the archived thread must
    // not call dismissByCorrelationId across the correlationId boundary.
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === "live")).not.toBeUndefined();
  });

  it("Mark all read excludes archived entries from its undo set", () => {
    setEntries([
      makeEntry({ id: "live-unread", message: "Live unread", seenAsToast: false }),
      makeEntry({
        id: "archived-unread",
        message: "Archived unread",
        seenAsToast: false,
        archivedAt: Date.now(),
      }),
    ]);
    render(<NotificationCenter open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    const archived = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.id === "archived-unread");
    // Archived entry's seenAsToast must stay false — it's done, not unread.
    expect(archived!.seenAsToast).toBe(false);
    // The toast message should report only the live unread count.
    expect(vi.mocked(notifyLib.notify)).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Marked 1 as read" })
    );
  });
});
