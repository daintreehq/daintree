import { useState, useCallback } from "react";
import { actionService } from "@/services/ActionService";

interface UseForgeBadgeTooltipParams {
  fetchTooltip: () => Promise<void>;
  reset: () => void;
  missingCredential: boolean;
  /** Resolved forge provider id — routes the missing-credential click to that provider's settings subtab. */
  providerId: string | null;
  isActive: boolean;
  onOpen?: () => void;
}

export function useForgeBadgeTooltip({
  fetchTooltip,
  reset,
  missingCredential,
  providerId,
  isActive,
  onOpen,
}: UseForgeBadgeTooltipParams) {
  const [isOpen, setIsOpen] = useState(false);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        void fetchTooltip();
      } else {
        void reset();
      }
    },
    [fetchTooltip, reset]
  );

  const handleClick = useCallback(() => {
    if (!isActive) return;
    if (missingCredential) {
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "code-forge", ...(providerId ? { subtab: providerId } : {}) },
        { source: "user" }
      );
      return;
    }
    onOpen?.();
  }, [isActive, missingCredential, providerId, onOpen]);

  return { isOpen, handleOpenChange, handleClick };
}
