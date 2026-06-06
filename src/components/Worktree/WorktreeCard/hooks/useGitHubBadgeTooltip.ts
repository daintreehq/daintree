import { useState, useCallback } from "react";
import { actionService } from "@/services/ActionService";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

interface UseGitHubBadgeTooltipParams {
  fetchTooltip: () => Promise<void>;
  reset: () => void;
  missingToken: boolean;
  isActive: boolean;
  onOpen?: () => void;
}

export function useGitHubBadgeTooltip({
  fetchTooltip,
  reset,
  missingToken,
  isActive,
  onOpen,
}: UseGitHubBadgeTooltipParams) {
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
    if (missingToken) {
      void actionService.dispatch(
        "app.settings.openTab",
        { tab: "code-forge", subtab: BUILTIN_GITHUB_PROVIDER_ID, sectionId: "github-token" },
        { source: "user" }
      );
      return;
    }
    onOpen?.();
  }, [isActive, missingToken, onOpen]);

  return { isOpen, handleOpenChange, handleClick };
}
