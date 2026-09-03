import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { isScheduledQuietNow } from "@shared/utils/quietHours";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

export function AllClearOverlay() {
  const [visible, setVisible] = useState(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    notificationsEnabled,
    flashEnabled,
    quietUntil,
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
    osDndActive,
  } = useNotificationSettingsStore(
    useShallow((s) => ({
      notificationsEnabled: s.enabled,
      flashEnabled: s.flashEnabled,
      quietUntil: s.quietUntil,
      quietHoursEnabled: s.quietHoursEnabled,
      quietHoursStartMin: s.quietHoursStartMin,
      quietHoursEndMin: s.quietHoursEndMin,
      quietHoursWeekdays: s.quietHoursWeekdays,
      osDndActive: s.osDndActive,
    }))
  );

  useEffect(() => {
    const cleanup = window.electron.terminal.onAllAgentsClear(() => {
      // The flash is the visual half of the same paired all-clear moment as
      // the sound (#12185) — it must obey the same gate and suppression
      // chain as AgentNotificationService.isInformationalAudioSuppressed.
      if (!notificationsEnabled || !flashEnabled) return;
      if (quietUntil > Date.now()) return;
      if (
        isScheduledQuietNow({
          quietHoursEnabled,
          quietHoursStartMin,
          quietHoursEndMin,
          quietHoursWeekdays,
        })
      ) {
        return;
      }
      if (osDndActive === true) return;

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (document.body.getAttribute("data-reduce-animations") === "true") return;
      if (document.body.getAttribute("data-performance-mode") === "true") return;

      setVisible(true);
    });
    return cleanup;
  }, [
    notificationsEnabled,
    flashEnabled,
    quietUntil,
    quietHoursEnabled,
    quietHoursStartMin,
    quietHoursEndMin,
    quietHoursWeekdays,
    osDndActive,
  ]);

  const handleAnimationEnd = useCallback((event: React.AnimationEvent) => {
    if (event.animationName === "all-clear-flash") {
      setVisible(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    safetyTimerRef.current = setTimeout(() => setVisible(false), 500);
    return () => {
      if (safetyTimerRef.current !== null) clearTimeout(safetyTimerRef.current);
    };
  }, [visible]);

  if (!visible) return null;

  return createPortal(
    <div
      className="fixed inset-0 pointer-events-none z-[200] animate-all-clear-flash bg-status-success"
      aria-hidden="true"
      onAnimationEnd={handleAnimationEnd}
    />,
    document.body
  );
}
