import { useRef, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { Bell, BellOff, Unplug } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NotificationCenter } from "@/components/Notifications/NotificationCenter";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useUIStore } from "@/store/uiStore";
import { useShallow } from "zustand/react/shallow";
import { isScheduledQuietNow } from "@shared/utils/quietHours";
import { DURATION_200, DURATION_250 } from "@/lib/animationUtils";

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function NotificationCenterToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const { notificationCenterOpen, toggleNotificationCenter, closeNotificationCenter } = useUIStore(
    useShallow((s) => ({
      notificationCenterOpen: s.notificationCenterOpen,
      toggleNotificationCenter: s.toggleNotificationCenter,
      closeNotificationCenter: s.closeNotificationCenter,
    }))
  );
  const notificationCenterButtonRef = useRef<HTMLButtonElement>(null);
  const notificationUnreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  const evictedToInboxCount = useNotificationHistoryStore((s) => s.evictedToInboxCount);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);
  const {
    enabled: notificationsEnabled,
    quietUntil,
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
  } = useNotificationSettingsStore(
    useShallow((s) => ({
      enabled: s.enabled,
      quietUntil: s.quietUntil,
      quietHoursEnabled: s.quietHoursEnabled,
      quietHoursStartMin: s.quietHoursStartMin,
      quietHoursEndMin: s.quietHoursEndMin,
      quietHoursWeekdays: s.quietHoursWeekdays,
    }))
  );

  // Force re-render at session-mute expiry and at scheduled quiet-hours
  // boundaries. Without this the icon stays in its old state until something
  // else triggers a render.
  const [, forceTick] = useState(0);
  const now = Date.now();
  const isSessionMuted = quietUntil > now;
  const isScheduledMuted = isScheduledQuietNow({
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
  });
  const isDndActive = isSessionMuted || isScheduledMuted;

  useEffect(() => {
    const tick = () => forceTick((n) => n + 1);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];

    const clearAll = () => {
      for (const t of timeouts) clearTimeout(t);
      for (const i of intervals) clearInterval(i);
      timeouts.length = 0;
      intervals.length = 0;
    };

    // Visibility may flip between scheduling and firing; bail out if hidden.
    const tickIfVisible = () => {
      if (document.hidden) return;
      tick();
    };

    const schedule = () => {
      if (isSessionMuted) {
        const delay = Math.max(0, quietUntil - Date.now());
        timeouts.push(setTimeout(tickIfVisible, delay + 50));
      }

      if (quietHoursEnabled) {
        // Coarse minute-poll re-render. Aligns to the next minute, then repeats.
        // Simpler than computing exact start/end edges across midnight/DST/weekday rollovers.
        const msToNextMinute = 60_000 - (Date.now() % 60_000);
        timeouts.push(
          setTimeout(() => {
            if (document.hidden) return;
            tick();
            intervals.push(setInterval(tickIfVisible, 60_000));
          }, msToNextMinute + 50)
        );
      }
    };

    const handleVisibility = () => {
      clearAll();
      if (!document.hidden) {
        tick();
        schedule();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    if (!document.hidden) {
      schedule();
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      clearAll();
    };
  }, [isSessionMuted, quietUntil, quietHoursEnabled]);

  useEffect(() => {
    if (!notificationsEnabled && notificationCenterOpen) closeNotificationCenter();
  }, [notificationsEnabled, notificationCenterOpen, closeNotificationCenter]);

  // Toggle a one-shot blip on the bell whenever a new notification lands in the
  // inbox while DND is inactive. Uses boolean class toggle with onAnimationEnd
  // cleanup (matching AgentStatusIndicator) instead of key-based remounting, so
  // no will-change layer hint lingers on the long-lived toolbar element.
  const prevEvictedRef = useRef(evictedToInboxCount);
  const lastBellBumpTimeRef = useRef(0);
  const [isBellBlipping, setIsBellBlipping] = useState(false);
  useEffect(() => {
    const prev = prevEvictedRef.current;
    prevEvictedRef.current = evictedToInboxCount;

    // Count decreased — clear any in-flight animation state and reset the
    // throttle clock so the next burst animates immediately. Acknowledging the
    // inbox should not gate a fresh arrival behind a stale throttle window.
    if (evictedToInboxCount < prev) {
      setIsBellBlipping(false);
      lastBellBumpTimeRef.current = 0;
      return;
    }

    if (evictedToInboxCount > prev && !isDndActive) {
      // Leading-edge throttle: drop bumps that arrive inside the previous
      // animation window so rapid-fire evictions don't strobe the bell. The
      // ref is only advanced when a blip actually fires, so DND-suppressed
      // increments don't consume the throttle window.
      const now = Date.now();
      if (now - lastBellBumpTimeRef.current < DURATION_250) return;
      lastBellBumpTimeRef.current = now;
      setIsBellBlipping(true);
    }
  }, [evictedToInboxCount, isDndActive]);

  const handleBellAnimationEnd = useCallback(() => {
    setIsBellBlipping(false);
  }, []);

  // Safety timeout — under reduced-motion CSS sets `animation: none`, so
  // `animationend` never fires and isBellBlipping would latch true.
  useEffect(() => {
    if (!isBellBlipping) return;
    const timer = setTimeout(() => setIsBellBlipping(false), DURATION_200 + 50);
    return () => clearTimeout(timer);
  }, [isBellBlipping]);

  // Screen-reader announcement on DND start / end transitions. Initialize the
  // ref to `isDndActive` so mounting while DND is already active does not
  // synthesize a spurious "Notifications resumed" announcement.
  const prevDndActiveRef = useRef(isDndActive);
  const [dndAnnouncement, setDndAnnouncement] = useState("");
  useEffect(() => {
    const prev = prevDndActiveRef.current;
    prevDndActiveRef.current = isDndActive;
    if (!notificationsEnabled) {
      // Bell is hidden; clear any prior announcement so it doesn't surface as
      // stale text the next time notifications are re-enabled.
      setDndAnnouncement("");
      return;
    }
    if (prev === isDndActive) return;
    if (isDndActive) {
      // Mirror the aria-label priority: isSessionMuted wins when both sources
      // overlap, so the live region and the button label agree on the reason.
      setDndAnnouncement(isSessionMuted ? "Notifications paused" : "Quiet hours active");
    } else {
      setDndAnnouncement("Notifications resumed");
    }
  }, [isDndActive, isSessionMuted, notificationsEnabled]);

  if (!notificationsEnabled) return null;

  const label = (() => {
    if (isSessionMuted) {
      return `Notifications — paused until ${timeFormatter.format(new Date(quietUntil))}`;
    }
    if (isScheduledMuted) return "Notifications — quiet hours active";
    if (notificationUnreadCount > 0) return `Notifications — ${notificationUnreadCount} unread`;
    return "Notifications";
  })();

  const Icon = isDndActive ? BellOff : Bell;

  return (
    <div className="relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={notificationCenterButtonRef}
                variant="ghost"
                size="icon"
                data-toolbar-item={dataToolbarItem}
                data-dnd-active={isDndActive ? "true" : undefined}
                onClick={toggleNotificationCenter}
                className={toolbarIconButtonClass}
                aria-label={label}
                aria-expanded={notificationCenterOpen}
                aria-haspopup="dialog"
              >
                <span
                  data-testid="notification-bell-icon"
                  className={isBellBlipping ? "inline-flex animate-activity-blip" : "inline-flex"}
                  onAnimationEnd={handleBellAnimationEnd}
                >
                  <Icon />
                </span>
                <span
                  data-testid="notification-unread-dot"
                  data-visible={notificationUnreadCount > 0}
                  data-dnd-active={isDndActive ? "true" : undefined}
                  className="toolbar-badge absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-daintree-text/50 ring-1 ring-daintree-bg/60"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
          <ContextMenuItem onSelect={() => toggleButtonVisibility("notification-center", "right")}>
            <Unplug className="mr-2 h-3.5 w-3.5" />
            Unpin from Toolbar
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <FixedDropdown
        open={notificationCenterOpen}
        onOpenChange={(open) => {
          if (!open) closeNotificationCenter();
        }}
        anchorRef={notificationCenterButtonRef}
        className="p-0"
      >
        <NotificationCenter open={notificationCenterOpen} onClose={closeNotificationCenter} />
      </FixedDropdown>
      <span
        data-testid="notification-dnd-announcement"
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {dndAnnouncement}
      </span>
    </div>
  );
}
