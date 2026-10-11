import { useCallback, useState } from "react";
import {
  useWorktrees,
  useNewTerminalPalette,
  usePanelPalette,
  useProjectSwitcherPalette,
} from "@/hooks";
import { useActionPalette } from "@/hooks/useActionPalette";
import { useQuickSwitcher } from "@/hooks/useQuickSwitcher";
import { useWorktreePalette } from "@/hooks/useWorktreePalette";
import { useQuickCreatePalette } from "@/hooks/useQuickCreatePalette";
import { useSendToAgentPalette } from "@/hooks/useSendToAgentPalette";
import { useProjectMruSwitcher } from "@/hooks/useProjectMruSwitcher";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { usePaletteStore } from "@/store";
import { useWorktreeStoreApi } from "@/hooks/useWorktreeStore";
import { getNormalizedWorktreeMap } from "@/hooks/useWorktrees";

/**
 * Composes the app's ~10 palette hooks (new-terminal, panel, project-switcher,
 * action, quick-switcher, send-to-agent, worktree, quick-create) plus the
 * theme/log-level/resume-sessions palette-store flags and every palette's
 * `useKeepMounted` exit-animation latch (#9917) into one typed bag.
 *
 * This runs in the app root, so the worktree list is only subscribed to while
 * a surface that shows it — the worktree palette or the overview — is open;
 * a whole-list subscription would re-render the root on every status tick.
 */
export function usePaletteWiring({ isWorktreeOverviewOpen }: { isWorktreeOverviewOpen: boolean }) {
  const isWorktreePaletteOpen = usePaletteStore((state) => state.activePaletteId === "worktree");
  const isWorktreeListShown = isWorktreePaletteOpen || isWorktreeOverviewOpen;
  const { worktrees: liveWorktrees, isLoading } = useWorktrees({ enabled: isWorktreeListShown });
  // The palette stays mounted through its exit animation, so hold the list it
  // closed with rather than letting the rows vanish mid-fade.
  const [lastShownWorktrees, setLastShownWorktrees] = useState(liveWorktrees);
  if (isWorktreeListShown && lastShownWorktrees !== liveWorktrees) {
    setLastShownWorktrees(liveWorktrees);
  }
  const worktrees = isWorktreeListShown ? liveWorktrees : lastShownWorktrees;

  const worktreeStore = useWorktreeStoreApi();
  const getWorktree = useCallback(
    (worktreeId: string) =>
      getNormalizedWorktreeMap(worktreeStore.getState().worktrees).get(worktreeId),
    [worktreeStore]
  );
  const newTerminalPalette = useNewTerminalPalette({ getWorktree });
  const panelPalette = usePanelPalette();
  const projectSwitcherPalette = useProjectSwitcherPalette();
  const actionPalette = useActionPalette();
  const quickSwitcher = useQuickSwitcher();
  const sendToAgentPalette = useSendToAgentPalette();
  useProjectMruSwitcher();
  const worktreePalette = useWorktreePalette({ worktrees });
  const quickCreatePalette = useQuickCreatePalette();

  const isThemePaletteOpen = usePaletteStore((state) => state.activePaletteId === "theme");
  const isLogLevelPaletteOpen = usePaletteStore((state) => state.activePaletteId === "log-level");
  const isResumeSessionsPaletteOpen = usePaletteStore(
    (state) => state.activePaletteId === "resume-sessions"
  );
  // Keep each palette mounted after its first open so its exit animation
  // (driven by useAnimatedPresence) can run — gating directly on `isOpen`
  // unmounts in the same React commit that flips it false, killing the exit
  // (#9917). The component still receives `isOpen` and gates its own DOM via
  // `shouldRender`.
  const isProjectSwitcherModalOpen =
    projectSwitcherPalette.isOpen && projectSwitcherPalette.mode === "modal";
  const shouldMountQuickSwitcher = useKeepMounted(quickSwitcher.isOpen);
  const shouldMountSendToAgentPalette = useKeepMounted(sendToAgentPalette.isOpen);
  const shouldMountNewTerminalPalette = useKeepMounted(newTerminalPalette.isOpen);
  const shouldMountWorktreePalette = useKeepMounted(worktreePalette.isOpen);
  const shouldMountQuickCreatePalette = useKeepMounted(quickCreatePalette.isOpen);
  const shouldMountPanelPalette = useKeepMounted(panelPalette.isOpen);
  const shouldMountThemePalette = useKeepMounted(isThemePaletteOpen);
  const shouldMountResumeSessionsPalette = useKeepMounted(isResumeSessionsPaletteOpen);
  const shouldMountLogLevelPalette = useKeepMounted(isLogLevelPaletteOpen);
  const shouldMountActionPalette = useKeepMounted(actionPalette.isOpen);

  return {
    worktrees,
    isLoading,
    newTerminalPalette,
    panelPalette,
    projectSwitcherPalette,
    actionPalette,
    quickSwitcher,
    sendToAgentPalette,
    worktreePalette,
    quickCreatePalette,
    isThemePaletteOpen,
    isLogLevelPaletteOpen,
    isResumeSessionsPaletteOpen,
    isProjectSwitcherModalOpen,
    shouldMountQuickSwitcher,
    shouldMountSendToAgentPalette,
    shouldMountNewTerminalPalette,
    shouldMountWorktreePalette,
    shouldMountQuickCreatePalette,
    shouldMountPanelPalette,
    shouldMountThemePalette,
    shouldMountResumeSessionsPalette,
    shouldMountLogLevelPalette,
    shouldMountActionPalette,
  };
}
