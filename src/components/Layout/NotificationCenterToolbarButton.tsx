import { useRef, useEffect, memo } from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { Bell } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NotificationCenter } from "@/components/Notifications/NotificationCenter";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useUIStore } from "@/store/uiStore";
import { useShallow } from "zustand/react/shallow";

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text transition-colors";

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
  const notificationsEnabled = useNotificationSettingsStore((s) => s.enabled);

  useEffect(() => {
    if (!notificationsEnabled && notificationCenterOpen) closeNotificationCenter();
  }, [notificationsEnabled, notificationCenterOpen, closeNotificationCenter]);

  if (!notificationsEnabled) return null;

  return (
    <div className="relative">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={notificationCenterButtonRef}
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={toggleNotificationCenter}
              className={toolbarIconButtonClass}
              aria-label={
                notificationUnreadCount > 0
                  ? `Notifications — ${notificationUnreadCount} unread`
                  : "Notifications"
              }
              aria-expanded={notificationCenterOpen}
              aria-haspopup="dialog"
            >
              <Bell />
              {notificationUnreadCount > 0 && (
                <span className="absolute top-1 right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-daintree-accent text-[9px] font-bold tabular-nums text-daintree-bg px-0.5 leading-none">
                  {notificationUnreadCount > 99 ? "99+" : notificationUnreadCount}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Notifications</TooltipContent>
        </Tooltip>
      </TooltipProvider>
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
