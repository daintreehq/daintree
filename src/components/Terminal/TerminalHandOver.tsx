import { useCallback, useRef, useState } from "react";
import { Unplug } from "lucide-react";
import { Joystick } from "@/components/icons";
import { usePanelStore } from "@/store";
import { useTerminalAdoptionStore } from "@/store/terminalAdoptionStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { closeAndAnnounce } from "@/lib/accessibility";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import type { TerminalAdoptionRefusal } from "@shared/types/ipc/mcpServer";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

/** A pane's name as its own header shows it, for naming it in hand-over copy. */
function usePaneName(paneId: string | undefined): string | null {
  return usePanelStore((state) => {
    if (paneId === undefined) return null;
    const panel = state.panelsById[paneId];
    return panel ? getTerminalDisplayTitle(panel, "base") : null;
  });
}

/**
 * Orchestrator panes in this view a terminal could be handed to (#12490).
 *
 * Main is asked when the menu opens, not kept in a store: which panes hold a
 * live Daintree bearer changes with every agent launch and exit, and only this
 * menu ever needs to know. Intersected with the view's own panels so the menu
 * names only panes the user can see, and never the terminal itself.
 */
export function useOrchestratorCandidates(terminalId: string): {
  candidateIds: string[];
  refresh: () => void;
} {
  // Tagged with the terminal they were fetched for: the dock hands one menu a
  // new terminal when its active tab changes, and a list fetched for the old
  // one would offer the new one to itself.
  const [candidates, setCandidates] = useState<{ terminalId: string; ids: string[] } | null>(null);
  const latestRequestRef = useRef(0);
  const refresh = useCallback(() => {
    const request = ++latestRequestRef.current;
    safeFireAndForget(
      window.electron.mcpServer.listOrchestratorPanes().then((paneIds) => {
        // An older opening's answer must not overwrite a newer one's.
        if (request !== latestRequestRef.current) return;
        const { panelsById } = usePanelStore.getState();
        setCandidates({
          terminalId,
          ids: paneIds.filter((paneId) => {
            const panel = panelsById[paneId];
            return paneId !== terminalId && panel !== undefined && panel.location !== "trash";
          }),
        });
      }),
      { context: "TerminalHandOver listOrchestratorPanes" }
    );
  }, [terminalId]);
  const candidateIds = candidates?.terminalId === terminalId ? candidates.ids : NO_CANDIDATES;
  return { candidateIds, refresh };
}

const NO_CANDIDATES: string[] = [];

function OrchestratorMenuItem({
  paneId,
  onSelect,
}: {
  paneId: string;
  onSelect: (paneId: string) => void;
}) {
  const name = usePaneName(paneId);
  if (name === null) return null;
  return (
    <ContextMenuItem aria-haspopup="dialog" onSelect={() => onSelect(paneId)}>
      <Joystick className={ICON_CLASS} aria-hidden="true" />
      {name}
    </ContextMenuItem>
  );
}

/**
 * The hand-over entries for one terminal's context menu: "Take back control"
 * while it is handed over, otherwise a submenu of the panes it could go to.
 * Renders nothing when neither applies, so a user who never runs an
 * orchestrator never sees the feature.
 */
export function TerminalHandOverMenuItems({
  terminalId,
  candidateIds,
  onRequestHandOver,
}: {
  terminalId: string;
  candidateIds: readonly string[];
  onRequestHandOver: (orchestratorPaneId: string) => void;
}) {
  const adoption = useTerminalAdoptionStore((s) => s.adoptionsByTerminalId[terminalId]);
  const driverName = usePaneName(adoption?.orchestratorPaneId);

  if (adoption !== undefined) {
    return (
      <ContextMenuItem
        onSelect={() =>
          safeFireAndForget(window.electron.mcpServer.releaseTerminalAdoption({ terminalId }), {
            context: "TerminalHandOver releaseTerminalAdoption",
          })
        }
      >
        <Unplug className={ICON_CLASS} aria-hidden="true" />
        {driverName ? `Take back from ${driverName}` : "Take back control"}
      </ContextMenuItem>
    );
  }

  if (candidateIds.length === 0) return null;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Joystick className={ICON_CLASS} aria-hidden="true" />
        Hand to orchestrator
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {candidateIds.map((paneId) => (
          <OrchestratorMenuItem key={paneId} paneId={paneId} onSelect={onRequestHandOver} />
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function refusalMessage(
  reason: TerminalAdoptionRefusal,
  orchestratorName: string,
  holderName: string | null
): string {
  switch (reason) {
    case "self":
      return "A pane can't be handed to itself.";
    case "not-orchestrator":
      return `${orchestratorName} isn't connected to Daintree anymore. Restart it to hand it terminals.`;
    case "terminal-gone":
      return "This terminal isn't running anymore.";
    case "other-project":
      return `${orchestratorName} belongs to another project.`;
    case "launched-by-orchestrator":
      return `${orchestratorName} launched this terminal, so it already drives it.`;
    case "launched-by-another":
      return "The agent that launched this terminal already drives it.";
    case "already-handed":
      return holderName
        ? `Already handed to ${holderName}. Take it back first.`
        : "Already handed to another pane. Take it back first.";
  }
}

/**
 * The consent step for a hand-over. Says plainly what the orchestrator gets —
 * everything the user could type — because Daintree filters none of it.
 */
export function TerminalHandOverDialog({
  terminalId,
  orchestratorPaneId,
  onClose,
  restoreFocusTo,
}: {
  terminalId: string;
  orchestratorPaneId: string;
  onClose: () => void;
  /** Where focus goes when the dialog closes — the pane the menu opened on. */
  restoreFocusTo?: RestoreFocusTarget;
}) {
  const terminalName = usePaneName(terminalId) ?? "this terminal";
  const orchestratorName = usePaneName(orchestratorPaneId) ?? "the orchestrator";
  // Why the hand-over didn't happen. Shown beside the action row, where the
  // user is looking, and the primary action stays disabled: nothing about a
  // retry would change the answer.
  const [refusal, setRefusal] = useState<
    { reason: TerminalAdoptionRefusal; heldByPaneId?: string } | { reason: "failed" } | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const holderName = usePaneName(
    refusal !== null && "heldByPaneId" in refusal ? refusal.heldByPaneId : undefined
  );

  const handleConfirm = useCallback(async () => {
    setIsSubmitting(true);
    try {
      const result = await window.electron.mcpServer.adoptTerminal({
        terminalId,
        orchestratorPaneId,
      });
      if (result.status === "handed-over") {
        closeAndAnnounce(onClose, `${terminalName} handed to ${orchestratorName}`);
        return;
      }
      setRefusal({
        reason: result.reason,
        ...(result.heldByPaneId !== undefined ? { heldByPaneId: result.heldByPaneId } : {}),
      });
    } catch {
      setRefusal({ reason: "failed" });
    } finally {
      setIsSubmitting(false);
    }
  }, [onClose, orchestratorName, orchestratorPaneId, terminalId, terminalName]);

  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      title={`Hand '${terminalName}' to '${orchestratorName}'?`}
      description={`${orchestratorName} will be able to type into this terminal and submit it, interrupt it, bring it on screen and read its last message, as if it had launched it. Daintree doesn't filter what it sends: answering a prompt with 1 can approve a push. It can't close the terminal, and you can take it back from this menu at any time.`}
      confirmLabel="Hand over terminal"
      variant="destructive"
      onConfirm={handleConfirm}
      restoreFocusTo={restoreFocusTo}
      isConfirmLoading={isSubmitting}
      confirmDisabled={refusal !== null}
      hint={
        refusal !== null ? (
          <span className="min-w-0 leading-tight" role="status">
            {refusal.reason === "failed"
              ? "Couldn't hand the terminal over. Close this and try again."
              : refusalMessage(refusal.reason, orchestratorName, holderName)}
          </span>
        ) : undefined
      }
    />
  );
}

/**
 * Ambient header pill on a handed-over terminal, naming the pane driving it.
 * A status signal, not an accent: the same neutral chip the hibernated badge
 * uses, and silent to screen readers until focused, like the rest of the row.
 */
export function TerminalDrivenByBadge({ terminalId }: { terminalId: string }) {
  const adoption = useTerminalAdoptionStore((s) => s.adoptionsByTerminalId[terminalId]);
  const driverName = usePaneName(adoption?.orchestratorPaneId);
  if (adoption === undefined) return null;
  const label = driverName ? `Driven by ${driverName}` : "Driven by an orchestrator";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="inline-flex items-center gap-1 min-w-0 max-w-[14rem] text-xs font-sans bg-overlay-soft text-text-secondary px-1.5 py-0.5 rounded-full border border-divider"
          role="status"
          aria-live="off"
          data-testid="terminal-driven-by-badge"
        >
          <Joystick className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{label}</span>
          <span>It can type into this terminal. Take it back from the terminal menu.</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
