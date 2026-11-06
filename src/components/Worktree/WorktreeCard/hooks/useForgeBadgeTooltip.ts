import { useState, useCallback } from "react";
import { actionService } from "@/services/ActionService";

interface UseForgeBadgeTooltipParams {
  fetchTooltip: () => Promise<void>;
  reset: () => void;
  missingCredential: boolean;
  /** Resolved forge provider id — routes the missing-credential click to that provider's settings subtab. */
  providerId: string | null;
  onOpen?: () => void;
}

export function useForgeBadgeTooltip({
  fetchTooltip,
  reset,
  missingCredential,
  providerId,
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

  // Opens on the first click on any card, the active one or not: a reference
  // that did nothing until its card was selected meant the same control did
  // two different things depending on which worktree was current (#15864).
  const handleClick = useCallback(() => {
    if (missingCredential) {
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "code-forge", ...(providerId ? { subtab: providerId } : {}) },
        { source: "user" }
      );
      return;
    }
    onOpen?.();
  }, [missingCredential, providerId, onOpen]);

  return { isOpen, handleOpenChange, handleClick };
}
