import { useCallback, useRef, useState } from "react";
import { Unplug } from "lucide-react";
import { Plug } from "@/components/icons";
import { usePanelStore } from "@/store";
import { useTerminalAdoptionStore } from "@/store/terminalAdoptionStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Callout } from "@/components/ui/Callout";
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
import { cn } from "@/lib/utils";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
} from "./terminalHeaderChip";

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
      <Plug className={ICON_CLASS} aria-hidden="true" />
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
        <Plug className={ICON_CLASS} aria-hidden="true" />
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
        ? `Already handed to ${holderName}. Choose “Take back from ${holderName}” in the terminal menu first.`
        : "Already handed to another pane. Choose “Take back control” in the terminal menu first.";
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
  const terminalPaneName = usePaneName(terminalId);
  const orchestratorPaneName = usePaneName(orchestratorPaneId);
  const terminalName = terminalPaneName ?? "this terminal";
  const orchestratorName = orchestratorPaneName ?? "the orchestrator";
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
      title={
        // One inline run: the title row is a flex box, which would space every
        // fragment of the sentence apart.
        <span className="min-w-0 break-words">
          <span className="font-normal">Hand over </span>
          <PaneName name={terminalPaneName} fallback="this terminal" />
          <span className="font-normal"> to </span>
          <PaneName name={orchestratorPaneName} fallback="the orchestrator" />
          <span className="font-normal">?</span>
        </span>
      }
      confirmLabel="Hand over terminal"
      variant="destructive"
      onConfirm={handleConfirm}
      restoreFocusTo={restoreFocusTo}
      isConfirmLoading={isSubmitting}
      confirmDisabled={refusal !== null}
      hintPlacement="above"
      hint={
        refusal !== null ? (
          <span className="min-w-0 leading-snug" role="status">
            {refusal.reason === "failed"
              ? "Couldn't hand the terminal over. Close this and try again."
              : refusalMessage(refusal.reason, orchestratorName, holderName)}
          </span>
        ) : undefined
      }
    >
      {/* One description, so the warning and the way back are announced with
          the consequence rather than left for a screen reader to find. */}
      <AppDialog.Description as="div" className="space-y-3">
        <p>
          {orchestratorPaneName ?? "The orchestrator"} can type and press Enter in this terminal,
          interrupt it, bring it on screen and read its last message.
        </p>
        <Callout severity="warning" title="It can approve actions for you" className="text-sm">
          Daintree doesn&apos;t filter what it sends. Answering an approval prompt with 1 can
          approve a git push.
        </Callout>
        <p>It can&apos;t close the terminal. Take it back any time from the terminal menu.</p>
      </AppDialog.Description>
    </ConfirmDialog>
  );
}

/**
 * A pane's own title inside the dialog's title. The names carry the title's
 * weight and the words around them drop to normal, which marks where a name
 * like `npm run dev` begins and ends without quoting it.
 */
function PaneName({ name, fallback }: { name: string | null; fallback: string }) {
  if (name === null) return <span className="font-normal">{fallback}</span>;
  return <bdi>{name}</bdi>;
}

/**
 * Ambient header pill on a handed-over terminal, naming the pane driving it.
 * A status signal, not an accent: the same neutral chip the hibernated badge
 * uses, focusable so the tooltip's way back reaches keyboard users, and silent
 * to screen readers until focused, like the rest of the row.
 */
export function TerminalDrivenByBadge({ terminalId }: { terminalId: string }) {
  const adoption = useTerminalAdoptionStore((s) => s.adoptionsByTerminalId[terminalId]);
  const driverName = usePaneName(adoption?.orchestratorPaneId);
  if (adoption === undefined) return null;
  const label = driverName ? `Driven by ${driverName}` : "Driven by an orchestrator";
  const takeBackLabel = driverName ? `Take back from ${driverName}` : "Take back control";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            HEADER_CHIP_CLASS,
            HEADER_CHIP_SURFACE,
            HEADER_CHIP_FOCUS_CLASS,
            "min-w-0 max-w-[14rem] shrink"
          )}
          role="status"
          aria-live="off"
          tabIndex={0}
          data-testid="terminal-driven-by-badge"
        >
          <Plug className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex min-w-0 flex-col gap-0.5 break-words">
          <span className="font-medium">{label}</span>
          <span>It can type and press Enter here, including at approval prompts.</span>
          <span className="mt-0.5 text-text-secondary">Terminal menu → {takeBackLabel}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
