import { Suspense, useState } from "react";
import type { WorktreeState } from "@shared/types";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useQuickSwitcher } from "./hooks/useQuickSwitcher";
import { useSendToAgentPalette } from "./hooks/useSendToAgentPalette";
import { useWorktreePalette } from "./hooks/useWorktreePalette";
import { useQuickCreatePalette } from "./hooks/useQuickCreatePalette";
import { MORE_AGENTS_PANEL_ID, usePanelPalette } from "./hooks/usePanelPalette";
import { useActionPalette } from "./hooks/useActionPalette";
import { useWorktrees } from "./hooks/useWorktrees";
import { useKeepMounted } from "./hooks/useKeepMounted";
import { usePaletteStore, type PaletteId } from "@/store/paletteStore";
import { launchPanelKind } from "@/registry/panelKindLaunch";
import { isPanelLimitError } from "@/services/actions/definitions/panelLimitError";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import {
  LazyQuickSwitcher,
  LazySendToAgentPalette,
  LazyWorktreePalette,
  LazyQuickCreatePalette,
  LazyPanelPalette,
  LazyThemePalette,
  LazyResumeSessionsPalette,
  LazyRecentDictationsPalette,
  LazyLogLevelPalette,
  LazyActionPalette,
  LazyWorktreeOverviewModal,
} from "./lazyPanels";

// Each palette's search state (query, selection, results) belongs to the host
// that renders it, never to the app shell: a keystroke re-renders this one
// host and nothing above it. Openers elsewhere reach a palette through
// `usePaletteStore.openPalette`, which `useSearchablePalette` answers with the
// same fresh start as the palette's own `open()`.
//
// Hosts stay mounted for the life of the view: some hooks react to state that
// lives outside the palette (quick-create follows the sidebar's "+" button),
// and each palette is latched mounted after its first opening so its exit
// animation can run (#9917). The component still receives `isOpen` and gates
// its own DOM.

export function QuickSwitcherHost() {
  const quickSwitcher = useQuickSwitcher();
  const shouldMount = useKeepMounted(quickSwitcher.isOpen);
  return (
    <ErrorBoundary
      variant="component"
      componentName="QuickSwitcher"
      resetKeys={[Number(quickSwitcher.isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyQuickSwitcher
            isOpen={quickSwitcher.isOpen}
            query={quickSwitcher.query}
            results={quickSwitcher.results}
            totalResults={quickSwitcher.totalResults}
            selectedIndex={quickSwitcher.selectedIndex}
            matchesById={quickSwitcher.matchesById}
            isLoading={quickSwitcher.isLoading}
            isFiltering={quickSwitcher.isFiltering}
            close={quickSwitcher.close}
            setQuery={quickSwitcher.setQuery}
            setSelectedIndex={quickSwitcher.setSelectedIndex}
            selectPrevious={quickSwitcher.selectPrevious}
            selectNext={quickSwitcher.selectNext}
            selectItem={quickSwitcher.selectItem}
            confirmSelection={quickSwitcher.confirmSelection}
            scopedProvider={quickSwitcher.scopedProvider}
            keywordProvider={quickSwitcher.keywordProvider}
            scopedStatus={quickSwitcher.scopedStatus}
            enterScope={quickSwitcher.enterScope}
            fileScope={quickSwitcher.fileScope}
            isFileKeyword={quickSwitcher.isFileKeyword}
            enterFileScope={quickSwitcher.enterFileScope}
            exitScope={quickSwitcher.exitScope}
          />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export function SendToAgentPaletteHost() {
  const sendToAgentPalette = useSendToAgentPalette();
  const shouldMount = useKeepMounted(sendToAgentPalette.isOpen);
  return (
    <ErrorBoundary
      variant="component"
      componentName="SendToAgentPalette"
      resetKeys={[Number(sendToAgentPalette.isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazySendToAgentPalette
            isOpen={sendToAgentPalette.isOpen}
            query={sendToAgentPalette.query}
            results={sendToAgentPalette.results}
            totalResults={sendToAgentPalette.totalResults}
            selectedIndex={sendToAgentPalette.selectedIndex}
            close={sendToAgentPalette.close}
            setQuery={sendToAgentPalette.setQuery}
            selectPrevious={sendToAgentPalette.selectPrevious}
            selectNext={sendToAgentPalette.selectNext}
            selectItem={sendToAgentPalette.selectItem}
            confirmSelection={sendToAgentPalette.confirmSelection}
            setSelectedIndex={sendToAgentPalette.setSelectedIndex}
          />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

/**
 * The worktree list, subscribed to only while `isShown`: a whole-list
 * subscription re-renders its owner on every worktree status tick. Once
 * hidden it holds the list it was last shown with, so a palette fading out
 * keeps its rows rather than losing them mid-animation.
 */
export function useShownWorktrees(isShown: boolean): WorktreeState[] {
  const { worktrees: liveWorktrees } = useWorktrees({ enabled: isShown });
  const [lastShownWorktrees, setLastShownWorktrees] = useState(liveWorktrees);
  if (isShown && lastShownWorktrees !== liveWorktrees) {
    setLastShownWorktrees(liveWorktrees);
  }
  return isShown ? liveWorktrees : lastShownWorktrees;
}

export function WorktreePaletteHost() {
  const isOpen = usePaletteStore((state) => state.activePaletteId === "worktree");
  const worktrees = useShownWorktrees(isOpen);
  const worktreePalette = useWorktreePalette({ worktrees });
  const shouldMount = useKeepMounted(worktreePalette.isOpen);
  return (
    <ErrorBoundary
      variant="component"
      componentName="WorktreePalette"
      resetKeys={[Number(worktreePalette.isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyWorktreePalette
            isOpen={worktreePalette.isOpen}
            query={worktreePalette.query}
            results={worktreePalette.results}
            totalResults={worktreePalette.totalResults}
            activeWorktreeId={worktreePalette.activeWorktreeId}
            selectedIndex={worktreePalette.selectedIndex}
            isStale={worktreePalette.isStale}
            onQueryChange={worktreePalette.setQuery}
            onSelectPrevious={worktreePalette.selectPrevious}
            onSelectNext={worktreePalette.selectNext}
            onSelect={worktreePalette.selectWorktree}
            onConfirm={worktreePalette.confirmSelection}
            onClose={worktreePalette.close}
            onSelectIndex={worktreePalette.setSelectedIndex}
          />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export function QuickCreatePaletteHost() {
  const quickCreatePalette = useQuickCreatePalette();
  const shouldMount = useKeepMounted(quickCreatePalette.isOpen);
  return (
    <ErrorBoundary
      variant="component"
      componentName="QuickCreatePalette"
      resetKeys={[Number(quickCreatePalette.isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyQuickCreatePalette palette={quickCreatePalette} />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

interface PanelPaletteHostProps {
  resumeSession: (session: AgentSessionRecord) => Promise<void>;
  handleLaunchAgent: (type: string) => void | Promise<void>;
  defaultTerminalCwd: string | undefined;
  activeWorktreeId: string | null;
}

export function PanelPaletteHost({
  resumeSession,
  handleLaunchAgent,
  defaultTerminalCwd,
  activeWorktreeId,
}: PanelPaletteHostProps) {
  const panelPalette = usePanelPalette();
  const shouldMount = useKeepMounted(panelPalette.isOpen);

  // Both palette activation paths (click and Enter) launch the same way, and
  // through the same seam the dock uses, so a kind can't behave differently
  // depending on which launcher opened it (#11668). The palette closes on
  // select, so a refusal has to be reported or it leaves no trace.
  const launchPanelFromPalette = (kindId: string, name: string) => {
    void launchPanelKind({
      kindId,
      location: "grid",
      cwd: defaultTerminalCwd,
      worktreeId: activeWorktreeId,
      source: "user",
    })
      .then((outcome) => {
        if (outcome.route !== "action" || outcome.result.ok) return;
        // A full grid is already reported by `addPanel` with the real recovery.
        if (isPanelLimitError(outcome.result.error.message)) return;
        logError("Panel launch from palette refused", outcome.result.error);
        notify({
          type: "error",
          title: `Couldn't open ${name}`,
          // Purpose-written, and general enough to stay true across every kind
          // the palette offers — the action's own messages name internal ids
          // and carry no fix.
          message:
            "No project folder or worktree resolved for this launch. Open a project or select a worktree, then try again.",
          // `uiFeedback` is passive; without this the palette's only signal
          // would be an inbox row.
          priority: "high",
          context: { eventKind: "uiFeedback" },
          action: { label: "Retry", onClick: () => launchPanelFromPalette(kindId, name) },
        });
      })
      .catch((error) => logError("Panel launch from palette failed", error));
  };

  return (
    <ErrorBoundary
      variant="component"
      componentName="PanelPalette"
      resetKeys={[Number(panelPalette.isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyPanelPalette
            isOpen={panelPalette.isOpen}
            query={panelPalette.query}
            results={panelPalette.results}
            totalResults={panelPalette.totalResults}
            selectedIndex={panelPalette.selectedIndex}
            matchesById={panelPalette.matchesById}
            onQueryChange={panelPalette.setQuery}
            onSelectPrevious={panelPalette.selectPrevious}
            onSelectNext={panelPalette.selectNext}
            onHoverIndex={panelPalette.setSelectedIndex}
            onSelect={(kind) => {
              const result = panelPalette.handleSelect(kind);
              if (!result) return;
              if (result.resumeSession) {
                void resumeSession(result.resumeSession);
              } else if (result.id.startsWith("agent:")) {
                const agentId = result.id.slice("agent:".length);
                if (agentId) {
                  void handleLaunchAgent(agentId);
                }
              } else {
                launchPanelFromPalette(result.id, result.name);
              }
            }}
            onConfirm={() => {
              const selected = panelPalette.confirmSelection();
              if (!selected) return;
              if (selected.id === MORE_AGENTS_PANEL_ID) return;
              if (selected.resumeSession) {
                void resumeSession(selected.resumeSession);
              } else if (selected.id.startsWith("agent:")) {
                const agentId = selected.id.slice("agent:".length);
                if (agentId) {
                  void handleLaunchAgent(agentId);
                }
              } else {
                launchPanelFromPalette(selected.id, selected.name);
              }
            }}
            onClose={panelPalette.close}
          />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

function useStorePaletteOpen(id: PaletteId): boolean {
  return usePaletteStore((state) => state.activePaletteId === id);
}

const closeThemePalette = () => usePaletteStore.getState().closePalette("theme");
const closeLogLevelPalette = () => usePaletteStore.getState().closePalette("log-level");

export function ThemePaletteHost() {
  const isOpen = useStorePaletteOpen("theme");
  const shouldMount = useKeepMounted(isOpen);
  return (
    <ErrorBoundary variant="component" componentName="ThemePalette" resetKeys={[Number(isOpen)]}>
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyThemePalette isOpen={isOpen} onClose={closeThemePalette} />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export function ResumeSessionsPaletteHost() {
  const isOpen = useStorePaletteOpen("resume-sessions");
  const shouldMount = useKeepMounted(isOpen);
  return (
    <ErrorBoundary
      variant="component"
      componentName="ResumeSessionsPalette"
      resetKeys={[Number(isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyResumeSessionsPalette />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export function RecentDictationsPaletteHost() {
  const isOpen = useStorePaletteOpen("recent-dictations");
  const shouldMount = useKeepMounted(isOpen);
  return (
    <ErrorBoundary
      variant="component"
      componentName="RecentDictationsPalette"
      resetKeys={[Number(isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyRecentDictationsPalette />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export function LogLevelPaletteHost() {
  const isOpen = useStorePaletteOpen("log-level");
  const shouldMount = useKeepMounted(isOpen);
  return (
    <ErrorBoundary variant="component" componentName="LogLevelPalette" resetKeys={[Number(isOpen)]}>
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyLogLevelPalette isOpen={isOpen} onClose={closeLogLevelPalette} />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export function ActionPaletteHost({
  onSearchProjects,
}: {
  onSearchProjects: (query: string) => void;
}) {
  const actionPalette = useActionPalette();
  const shouldMount = useKeepMounted(actionPalette.isOpen);
  return (
    <ErrorBoundary
      variant="component"
      componentName="ActionPalette"
      resetKeys={[Number(actionPalette.isOpen)]}
    >
      {shouldMount && (
        <Suspense fallback={null}>
          <LazyActionPalette
            isOpen={actionPalette.isOpen}
            query={actionPalette.query}
            results={actionPalette.results}
            totalResults={actionPalette.totalResults}
            selectedIndex={actionPalette.selectedIndex}
            isStale={actionPalette.isStale}
            sections={actionPalette.sections}
            close={actionPalette.close}
            setQuery={actionPalette.setQuery}
            setSelectedIndex={actionPalette.setSelectedIndex}
            selectPrevious={actionPalette.selectPrevious}
            selectNext={actionPalette.selectNext}
            executeAction={actionPalette.executeAction}
            confirmSelection={actionPalette.confirmSelection}
            pinAction={actionPalette.pinAction}
            unpinAction={actionPalette.unpinAction}
            hideAction={actionPalette.hideAction}
            argPrompt={actionPalette.argPrompt}
            argBack={actionPalette.argBack}
            onSearchProjects={onSearchProjects}
          />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

interface WorktreeOverviewHostProps {
  isOpen: boolean;
  onClose: () => void;
  activeWorktreeId: string | null;
  onSelectWorktree: (id: string, options?: { source?: "user" | "focus" }) => void;
}

export function WorktreeOverviewHost({
  isOpen,
  onClose,
  activeWorktreeId,
  onSelectWorktree,
}: WorktreeOverviewHostProps) {
  // Mounted only while open, so the list needs no hold for an exit animation.
  const { worktrees, isLoading } = useWorktrees({ enabled: isOpen });
  return (
    <ErrorBoundary
      variant="component"
      componentName="WorktreeOverviewModal"
      resetKeys={[Number(isOpen)]}
    >
      {isOpen && (
        <Suspense fallback={null}>
          <LazyWorktreeOverviewModal
            isOpen={isOpen}
            onClose={onClose}
            worktrees={worktrees}
            isLoading={isLoading}
            activeWorktreeId={activeWorktreeId}
            onSelectWorktree={onSelectWorktree}
          />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}
