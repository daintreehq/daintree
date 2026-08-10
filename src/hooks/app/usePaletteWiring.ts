import { useWorktrees } from "@/hooks/useWorktrees";
import { useNewTerminalPalette } from "@/hooks/useNewTerminalPalette";
import { usePanelPalette } from "@/hooks/usePanelPalette";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";
import { useActionPalette } from "@/hooks/useActionPalette";
import { useQuickSwitcher } from "@/hooks/useQuickSwitcher";
import { useWorktreePalette } from "@/hooks/useWorktreePalette";
import { useQuickCreatePalette } from "@/hooks/useQuickCreatePalette";
import { useSendToAgentPalette } from "@/hooks/useSendToAgentPalette";
import { useDoubleShift } from "@/hooks/useDoubleShift";
import { useProjectMruSwitcher } from "@/hooks/useProjectMruSwitcher";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { usePaletteStore } from "@/store";

/**
 * Composes the app's ~10 palette hooks (new-terminal, panel, project-switcher,
 * action, quick-switcher, send-to-agent, worktree, quick-create) plus the
 * theme/log-level/resume-sessions palette-store flags and every palette's
 * `useKeepMounted` exit-animation latch (#9917) into one typed bag.
 */
export function usePaletteWiring() {
  const { worktrees, worktreeMap, isLoading } = useWorktrees();
  const newTerminalPalette = useNewTerminalPalette({ worktreeMap });
  const panelPalette = usePanelPalette();
  const projectSwitcherPalette = useProjectSwitcherPalette();
  const actionPalette = useActionPalette();
  const quickSwitcher = useQuickSwitcher();
  const sendToAgentPalette = useSendToAgentPalette();
  useDoubleShift(actionPalette.toggle);
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
