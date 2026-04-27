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
import { render } from "@testing-library/react";
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
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
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
      // Locale-dependent formatting — match the time portion loosely.
      expect(label).toMatch(/2:30/);
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
});
