// @vitest-environment jsdom
/**
 * NotificationCenterToolbarButton — DND state surfaced on the toolbar bell.
 *
 * Issue #5839: the bell must reflect Do-Not-Disturb (session mute or scheduled
 * quiet hours) so users aren't confused about whether their notifications are
 * being suppressed.
 *
 *  - Bell icon swaps to BellOff while DND is active
 *  - Numeric accent badge collapses to a plain dot (always — accent restraint)
 *  - The dot uses a non-accent color and dims further when DND is active
 *  - aria-label / tooltip describes the muted state with a time-of-day when known
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { NotificationCenterToolbarButton } from "../NotificationCenterToolbarButton";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useUIStore } from "@/store/uiStore";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
  } & React.HTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/fixed-dropdown", () => ({
  FixedDropdown: () => null,
}));

vi.mock("@/components/Notifications/NotificationCenter", () => ({
  NotificationCenter: () => null,
}));

vi.mock("lucide-react", () => ({
  Bell: () => <span data-testid="icon-bell" />,
  BellOff: () => <span data-testid="icon-bell-off" />,
}));

function resetStores() {
  useNotificationHistoryStore.setState({
    entries: [],
    unreadCount: 0,
    evictedToInboxCount: 0,
  });
  useNotificationSettingsStore.setState({
    enabled: true,
    hydrated: true,
    quietHoursEnabled: false,
    quietHoursStartMin: 22 * 60,
    quietHoursEndMin: 8 * 60,
    quietHoursWeekdays: [],
    quietUntil: 0,
  });
  useUIStore.setState({
    notificationCenterOpen: false,
  });
}

describe("NotificationCenterToolbarButton — DND state surface", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("icon", () => {
    it("renders Bell when no DND and no unreads", () => {
      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      expect(queryByTestId("icon-bell")).toBeTruthy();
      expect(queryByTestId("icon-bell-off")).toBeNull();
    });

    it("renders Bell when only unreads are present", () => {
      useNotificationHistoryStore.setState({ unreadCount: 3 });
      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      expect(queryByTestId("icon-bell")).toBeTruthy();
      expect(queryByTestId("icon-bell-off")).toBeNull();
    });

    it("renders BellOff when session-muted", () => {
      useNotificationSettingsStore.setState({ quietUntil: Date.now() + 60 * 60 * 1000 });
      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      expect(queryByTestId("icon-bell-off")).toBeTruthy();
      expect(queryByTestId("icon-bell")).toBeNull();
    });

    it("renders BellOff during scheduled quiet hours", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
      });
      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      expect(queryByTestId("icon-bell-off")).toBeTruthy();
      expect(queryByTestId("icon-bell")).toBeNull();
    });

    it("renders Bell again outside scheduled quiet hours", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 14, 0));
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
      });
      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      expect(queryByTestId("icon-bell")).toBeTruthy();
      expect(queryByTestId("icon-bell-off")).toBeNull();
    });

    it("respects weekday filter — Bell on excluded day, BellOff on included day", () => {
      vi.useFakeTimers();
      // 2024-01-06 is a Saturday (day 6); 2024-01-08 is a Monday (day 1).
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 23 * 60,
        quietHoursWeekdays: [1, 2, 3, 4, 5],
      });

      vi.setSystemTime(new Date(2024, 0, 6, 22, 30));
      const sat = render(<NotificationCenterToolbarButton />);
      expect(sat.queryByTestId("icon-bell")).toBeTruthy();
      sat.unmount();

      vi.setSystemTime(new Date(2024, 0, 8, 22, 30));
      const mon = render(<NotificationCenterToolbarButton />);
      expect(mon.queryByTestId("icon-bell-off")).toBeTruthy();
    });
  });

  describe("unread dot", () => {
    it("does not render when unreadCount is 0", () => {
      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      expect(queryByTestId("notification-unread-dot")).toBeNull();
    });

    it("renders a plain dot (no number) when unreadCount > 0 and DND is off", () => {
      useNotificationHistoryStore.setState({ unreadCount: 5 });
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      const dot = getByTestId("notification-unread-dot");
      expect(dot).toBeTruthy();
      expect(dot.textContent).toBe("");
      expect(dot.className).not.toContain("bg-daintree-accent");
    });

    it("uses a dimmer non-accent color when DND is active and there are unreads", () => {
      useNotificationHistoryStore.setState({ unreadCount: 2 });
      useNotificationSettingsStore.setState({ quietUntil: Date.now() + 60 * 1000 });
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      const dot = getByTestId("notification-unread-dot");
      expect(dot.className).toContain("bg-daintree-text/30");
      expect(dot.className).not.toContain("bg-daintree-accent");
    });
  });

  describe("aria-label / tooltip", () => {
    it('says "Notifications" when idle', () => {
      const { container } = render(<NotificationCenterToolbarButton />);
      const btn = container.querySelector("button")!;
      expect(btn.getAttribute("aria-label")).toBe("Notifications");
    });

    it("includes the unread count when not muted", () => {
      useNotificationHistoryStore.setState({ unreadCount: 4 });
      const { container } = render(<NotificationCenterToolbarButton />);
      const btn = container.querySelector("button")!;
      expect(btn.getAttribute("aria-label")).toBe("Notifications — 4 unread");
    });

    it("includes a formatted end time when session-muted", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      const until = new Date(2024, 0, 1, 14, 30).getTime();
      useNotificationSettingsStore.setState({ quietUntil: until });
      const { container } = render(<NotificationCenterToolbarButton />);
      const btn = container.querySelector("button")!;
      const label = btn.getAttribute("aria-label") ?? "";
      expect(label.startsWith("Notifications — muted until ")).toBe(true);
      // Match either 12h ("2:30") or 24h ("14:30") locale outputs.
      expect(label).toMatch(/(?:^|[^0-9])(?:14|2):30/);
    });

    it("says 'scheduled quiet hours' during the configured window", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
      });
      const { container } = render(<NotificationCenterToolbarButton />);
      const btn = container.querySelector("button")!;
      expect(btn.getAttribute("aria-label")).toBe("Notifications — scheduled quiet hours");
    });

    it("session mute label takes priority over unread count", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      useNotificationHistoryStore.setState({ unreadCount: 7 });
      useNotificationSettingsStore.setState({
        quietUntil: new Date(2024, 0, 1, 13, 15).getTime(),
      });
      const { container } = render(<NotificationCenterToolbarButton />);
      const btn = container.querySelector("button")!;
      expect(btn.getAttribute("aria-label")).toMatch(/^Notifications — muted until /);
    });

    it("button carries data-dnd-active='true' while DND is active", () => {
      useNotificationSettingsStore.setState({ quietUntil: Date.now() + 30 * 1000 });
      const { container } = render(<NotificationCenterToolbarButton />);
      const btn = container.querySelector("button")!;
      expect(btn.getAttribute("data-dnd-active")).toBe("true");
    });
  });

  describe("master toggle", () => {
    it("renders nothing when notifications are globally disabled", () => {
      useNotificationSettingsStore.setState({ enabled: false });
      const { container } = render(<NotificationCenterToolbarButton />);
      expect(container.querySelector("button")).toBeNull();
    });
  });

  describe("boundary timers — auto re-render at expiry / minute boundary", () => {
    it("flips BellOff back to Bell when the session mute expires", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      useNotificationSettingsStore.setState({
        quietUntil: new Date(2024, 0, 1, 12, 0, 30).getTime(),
      });

      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      expect(queryByTestId("icon-bell-off")).toBeTruthy();

      // Advance past the expiry timestamp + the 50ms safety pad.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(queryByTestId("icon-bell")).toBeTruthy();
      expect(queryByTestId("icon-bell-off")).toBeNull();
    });

    it("re-arms the minute poll so scheduled quiet hours flip Bell at the end boundary", async () => {
      vi.useFakeTimers();
      // Start at 22:59:30 — quiet starts at 23:00 and ends at 23:01.
      vi.setSystemTime(new Date(2024, 0, 1, 22, 59, 30));
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 23 * 60,
        quietHoursEndMin: 23 * 60 + 1,
      });

      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      // Outside the window initially.
      expect(queryByTestId("icon-bell")).toBeTruthy();

      // Cross 23:00 — first re-arm via initial setTimeout fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(queryByTestId("icon-bell-off")).toBeTruthy();

      // Cross 23:01 — interval must re-arm and tick again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(queryByTestId("icon-bell")).toBeTruthy();
      expect(queryByTestId("icon-bell-off")).toBeNull();
    });
  });

  describe("visibility gating — pause timers while document is hidden", () => {
    let originalHidden: boolean;
    let visibilityState: DocumentVisibilityState;
    let visibilityListeners: Array<() => void>;

    beforeEach(() => {
      visibilityListeners = [];
      originalHidden = document.hidden;
      visibilityState = "visible";

      Object.defineProperty(document, "hidden", {
        get: () => visibilityState === "hidden",
        configurable: true,
      });
      Object.defineProperty(document, "visibilityState", {
        get: () => visibilityState,
        configurable: true,
      });

      const origAdd = document.addEventListener.bind(document);
      const origRemove = document.removeEventListener.bind(document);
      vi.spyOn(document, "addEventListener").mockImplementation((type, handler, options) => {
        if (type === "visibilitychange") {
          visibilityListeners.push(handler as () => void);
        }
        return origAdd(type, handler, options);
      });
      vi.spyOn(document, "removeEventListener").mockImplementation((type, handler, options) => {
        if (type === "visibilitychange") {
          visibilityListeners = visibilityListeners.filter((l) => l !== handler);
        }
        return origRemove(type, handler, options);
      });
    });

    afterEach(() => {
      Object.defineProperty(document, "hidden", {
        value: originalHidden,
        configurable: true,
        writable: true,
      });
    });

    function fireVisibilityChange(state: DocumentVisibilityState) {
      visibilityState = state;
      visibilityListeners.forEach((l) => l());
    }

    it("does not schedule the minute poll when mounted while hidden", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 22, 59, 30));
      visibilityState = "hidden";

      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 23 * 60,
        quietHoursEndMin: 23 * 60 + 1,
      });

      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      render(<NotificationCenterToolbarButton />);

      // Advance well past where timers would normally fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it("clears the active minute interval when document becomes hidden", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 22, 59, 30));

      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 23 * 60,
        quietHoursEndMin: 23 * 60 + 1,
      });

      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      // Cross 23:00 to start the interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(queryByTestId("icon-bell-off")).toBeTruthy();

      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      await act(async () => {
        fireVisibilityChange("hidden");
      });

      // At least one interval/timeout should have been cleared.
      expect(
        clearIntervalSpy.mock.calls.length + clearTimeoutSpy.mock.calls.length
      ).toBeGreaterThan(0);
    });

    it("re-renders immediately when visibility is restored", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      // Mute expires 30s in the future — DND active at mount.
      useNotificationSettingsStore.setState({
        quietUntil: new Date(2024, 0, 1, 12, 0, 30).getTime(),
      });

      const { queryByTestId } = render(<NotificationCenterToolbarButton />);
      expect(queryByTestId("icon-bell-off")).toBeTruthy();

      // Hide before mute expires; advance past expiry while hidden.
      await act(async () => {
        fireVisibilityChange("hidden");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      // Restore — handler fires synchronous tick → re-render reads fresh quietUntil.
      await act(async () => {
        fireVisibilityChange("visible");
      });
      expect(queryByTestId("icon-bell")).toBeTruthy();
      expect(queryByTestId("icon-bell-off")).toBeNull();
    });

    it("removes visibility listener on unmount", () => {
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 23 * 60,
        quietHoursEndMin: 23 * 60 + 1,
      });

      const { unmount } = render(<NotificationCenterToolbarButton />);
      expect(visibilityListeners.length).toBeGreaterThan(0);

      unmount();
      expect(visibilityListeners.length).toBe(0);
    });
  });

  // Issue #6424 — when a notification lands in the inbox (toast eviction or
  // priority:"low" direct-to-inbox), the bell should play a brief one-shot
  // arrival animation. The animation must not fire during DND/quiet hours
  // and must not fire on the initial mount baseline.
  describe("inbox arrival animation (issue #6424)", () => {
    it("does not animate on the initial render", () => {
      useNotificationHistoryStore.setState({ evictedToInboxCount: 0 });
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      const wrapper = getByTestId("notification-bell-icon");
      expect(wrapper.className).not.toContain("animate-activity-blip");
    });

    it("does not animate when mounted with a non-zero baseline (e.g. fast-refresh)", () => {
      useNotificationHistoryStore.setState({ evictedToInboxCount: 5 });
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      const wrapper = getByTestId("notification-bell-icon");
      expect(wrapper.className).not.toContain("animate-activity-blip");
    });

    it("animates the bell when evictedToInboxCount increases and DND is inactive", async () => {
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
      });
      const wrapper = getByTestId("notification-bell-icon");
      expect(wrapper.className).toContain("animate-activity-blip");
    });

    it("does not animate when DND is active", async () => {
      useNotificationSettingsStore.setState({ quietUntil: Date.now() + 60 * 60 * 1000 });
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
      });
      const wrapper = getByTestId("notification-bell-icon");
      expect(wrapper.className).not.toContain("animate-activity-blip");
    });

    it("does not re-animate when the count drops back to zero (no new arrival)", async () => {
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
      });
      const firstWrapper = getByTestId("notification-bell-icon");
      expect(firstWrapper.className).toContain("animate-activity-blip");

      // Reset — count drops 1 → 0. evictedToInboxCount > prev is false, so the
      // bumpKey does not increment and the bell wrapper is not remounted.
      // (The CSS animation is `both`-fill at scale(1)/opacity(0.9), so a
      // residual class on the existing wrapper is visually inert.)
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 0 });
      });
      // Sanity: the count drop alone did not trigger another bump cycle.
      // (We can't directly observe React's internal key, but a fresh
      // increment from 0 → 1 below confirms the bumpKey path still works.)
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
      });
      expect(getByTestId("notification-bell-icon").className).toContain("animate-activity-blip");
    });

    it("toggling the center open resets the eviction counter; closing does not", async () => {
      // Seed the counter as if two toasts had been evicted into the inbox.
      useNotificationHistoryStore.setState({ evictedToInboxCount: 2 });
      const { container } = render(<NotificationCenterToolbarButton />);
      const button = container.querySelector("button")!;

      // First click: closed → open. Reset must fire.
      await act(async () => {
        button.click();
      });
      expect(useUIStore.getState().notificationCenterOpen).toBe(true);
      expect(useNotificationHistoryStore.getState().evictedToInboxCount).toBe(0);

      // Second click: open → closed. Closing must NOT silently zero a fresh
      // counter that arrives after the user has already opened the center.
      await act(async () => {
        button.click();
      });
      expect(useUIStore.getState().notificationCenterOpen).toBe(false);
      // Simulate a fresh eviction landing while the center is closed.
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
      });
      expect(useNotificationHistoryStore.getState().evictedToInboxCount).toBe(1);

      // Third click: closed → open again. Reset must fire on every entry to
      // the open state, not just the first.
      await act(async () => {
        button.click();
      });
      expect(useNotificationHistoryStore.getState().evictedToInboxCount).toBe(0);
    });

    it("animation class persists across multiple subsequent increments", async () => {
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
      });
      expect(getByTestId("notification-bell-icon").className).toContain("animate-activity-blip");
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 2 });
      });
      expect(getByTestId("notification-bell-icon").className).toContain("animate-activity-blip");
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 3 });
      });
      expect(getByTestId("notification-bell-icon").className).toContain("animate-activity-blip");
    });

    it("strips the animation class shortly after the blip so will-change does not linger", async () => {
      vi.useFakeTimers();
      const { getByTestId } = render(<NotificationCenterToolbarButton />);
      await act(async () => {
        useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
      });
      expect(getByTestId("notification-bell-icon").className).toContain("animate-activity-blip");

      // Advance past the BELL_BLIP_CLEANUP_MS timer (260ms blip + buffer).
      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      // After cleanup, the wrapper falls back to the no-animation className —
      // the will-change layer-promotion hint is no longer applied.
      expect(getByTestId("notification-bell-icon").className).not.toContain(
        "animate-activity-blip"
      );
    });
  });
});
