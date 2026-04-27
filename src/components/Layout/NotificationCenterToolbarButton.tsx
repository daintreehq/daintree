import { useRef, useEffect, useState, memo } from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { Bell, BellOff } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NotificationCenter } from "@/components/Notifications/NotificationCenter";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useUIStore } from "@/store/uiStore";
import { useShallow } from "zustand/react/shallow";
import { isScheduledQuietNow } from "@shared/utils/quietHours";

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text transition-colors";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export const NotificationCenterToolbarButton = memo(function NotificationCenterToolbarButton({
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

    if (isSessionMuted) {
      const delay = Math.max(0, quietUntil - Date.now());
      timeouts.push(setTimeout(tick, delay + 50));
    }

    if (quietHoursEnabled) {
      // Coarse minute-poll re-render. Aligns to the next minute, then repeats.
      // Simpler than computing exact start/end edges across midnight/DST/weekday rollovers.
      const msToNextMinute = 60_000 - (Date.now() % 60_000);
      timeouts.push(
        setTimeout(() => {
          tick();
          intervals.push(setInterval(tick, 60_000));
        }, msToNextMinute + 50)
      );
    }

    return () => {
      for (const t of timeouts) clearTimeout(t);
      for (const i of intervals) clearInterval(i);
    };
  }, [isSessionMuted, quietUntil, quietHoursEnabled]);

  useEffect(() => {
    if (!notificationsEnabled && notificationCenterOpen) closeNotificationCenter();
  }, [notificationsEnabled, notificationCenterOpen, closeNotificationCenter]);

  if (!notificationsEnabled) return null;

  const label = (() => {
    if (isSessionMuted) {
      return `Notifications — muted until ${timeFormatter.format(new Date(quietUntil))}`;
    }
    if (isScheduledMuted) return "Notifications — scheduled quiet hours";
    if (notificationUnreadCount > 0) return `Notifications — ${notificationUnreadCount} unread`;
    return "Notifications";
  })();

  const Icon = isDndActive ? BellOff : Bell;
  const dotColor = isDndActive ? "bg-daintree-text/30" : "bg-daintree-text/50";

  return (
    <div className="relative">
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
            <Icon />
            {notificationUnreadCount > 0 && (
              <span
                data-testid="notification-unread-dot"
                className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ring-1 ring-daintree-bg/60 ${dotColor}`}
              />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
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
    </div>
  );
});
