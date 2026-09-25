import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { ArrowLeftRight, DaintreeIcon, FolderGit2 } from "@/components/icons";
import { TerminalWatchChip } from "@/components/Terminal/TerminalWatchChip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentConfig } from "@/config/agents";
import type { McpToolActivityState } from "@/controllers/HelpSessionController";
import type { PinnedActionContextSnapshot } from "@shared/types/ipc/help";
import type { TurnOutcomeAlertClass } from "@shared/types/ipc/mcpServer";
import { McpActivityStrip } from "./McpActivityStrip";
import { TurnOutcomePip } from "./TurnOutcomePip";
import { FOOTER_ITEM_CLASS } from "./footerItem";

interface HelpPanelFooterProps {
  sessionId: string | null;
  activity: McpToolActivityState | null;
  outcomeAlert: TurnOutcomeAlertClass | null;
  onDismissOutcome: () => void;
  terminalId: string | null;
  pinnedContext: PinnedActionContextSnapshot | null;
  isPinnedWorktreeDiverged: boolean;
  onReturnToPinnedWorktree: () => void;
  agentId: string;
  agentConfig: AgentConfig;
  launchedModelLabel: string | null;
}

/**
 * The pinned binding as one label. A worktree is usually named after its
 * branch, so the pair collapses to a single value when they match rather than
 * spending half the row saying the same thing twice.
 */
export function formatPinnedBinding(context: PinnedActionContextSnapshot): string {
  const name = context.worktreeName?.trim() || null;
  const branch = context.worktreeBranch?.trim() || null;
  if (name && branch && name !== branch) return `${name} · ${branch}`;
  return name ?? branch ?? "Pinned session";
}

/**
 * How far the row has had to compact to stay on one line. Each step gives up
 * the least useful remaining detail: 1 hides the model, 2 the agent name
 * (its icon stays), 3 the live tool id (its glyph stays), 4 the binding text.
 */
export const MAX_FOOTER_DENSITY = 4;

/**
 * Measures the row after each layout and steps the density up until nothing
 * overflows, before paint, so an overflowing frame is never shown.
 *
 * Density belongs to a generation: the row's content plus an epoch that bumps
 * whenever the row changes under it without new props (a width change, the
 * watch chip resolving, the activity row decaying). A new generation starts
 * from the roomiest layout, so detail comes back as soon as there is room.
 *
 * Telling those outside changes from the row's own compaction is done by
 * measurement, not by flagging commits: once a generation settles, the width
 * of every item in the row is recorded, and a later DOM change only restarts
 * if one of them moved or the row overflows. Every item, not just the spacer:
 * space a child gives up is often absorbed by a truncated sibling growing
 * back, with the spacer still at its minimum. The row's own steps are already
 * part of the recorded layout, so they can never re-trigger a restart.
 */
function measureItems(row: HTMLElement): string {
  return Array.from(row.children, (child) =>
    child instanceof HTMLElement ? child.offsetWidth : 0
  ).join(",");
}

export function useFooterDensity(contentKey: string) {
  // State, not a ref: the row node can be replaced under this hook (the
  // tooltip provider above it swaps in once Radix loads), and a new node has
  // to be observed and measured again.
  const [row, rowRef] = useState<HTMLDivElement | null>(null);
  const settledLayout = useRef<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const generation = `${contentKey}#${epoch}`;
  const [step, setStep] = useState({ generation, density: 0 });
  const density = step.generation === generation ? step.density : 0;

  useLayoutEffect(() => {
    if (row && density < MAX_FOOTER_DENSITY && row.scrollWidth > row.clientWidth) {
      setStep({ generation, density: density + 1 });
      return;
    }
    settledLayout.current = row ? measureItems(row) : null;
  }, [density, generation, row]);

  useLayoutEffect(() => {
    if (!row) return;
    const restart = () => setEpoch((e) => e + 1);
    const mutations = new MutationObserver(() => {
      if (measureItems(row) !== settledLayout.current || row.scrollWidth > row.clientWidth) {
        restart();
      }
    });
    mutations.observe(row, { childList: true, subtree: true, characterData: true });
    let lastWidth = row.clientWidth;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (row.clientWidth === lastWidth) return;
            lastWidth = row.clientWidth;
            restart();
          });
    resize?.observe(row);
    return () => {
      mutations.disconnect();
      resize?.disconnect();
    };
  }, [row]);

  return { rowRef, density };
}

/** A focusable status item whose full value shows on hover and on focus. */
function StatusItem({
  tip,
  className,
  children,
  ...rest
}: {
  tip: ReactNode;
  className?: string;
  children: ReactNode;
  "data-footer-binding"?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(FOOTER_ITEM_CLASS, "hover:bg-transparent", className)}
          {...rest}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Bottom info bar — a single status row (#9763). Left: what happened (tool-call
 * activity, the last turn's outcome, terminal watches). Right: where the
 * assistant's calls land and which agent is making them.
 *
 * One line in every state, at every panel width. The binding truncates first;
 * past that the row compacts in the order `useFooterDensity` documents.
 * Signals (the outcome label, the watch count, every glyph) never shrink, and
 * every value that is truncated or hidden stays in a tooltip on hover and
 * focus, and in the accessible text.
 */
export function HelpPanelFooter({
  sessionId,
  activity,
  outcomeAlert,
  onDismissOutcome,
  terminalId,
  pinnedContext,
  isPinnedWorktreeDiverged,
  onReturnToPinnedWorktree,
  agentId,
  agentConfig,
  launchedModelLabel,
}: HelpPanelFooterProps) {
  const agentName = agentId === "daintree-assistant" ? "Assistant" : agentConfig.name;
  const AgentIcon = agentId === "daintree-assistant" ? DaintreeIcon : agentConfig.icon;
  const agentDescription = launchedModelLabel
    ? `${agentConfig.name} · ${launchedModelLabel}`
    : agentConfig.name;
  const binding = pinnedContext ? formatPinnedBinding(pinnedContext) : null;

  const { rowRef, density } = useFooterDensity(
    [
      binding,
      isPinnedWorktreeDiverged,
      agentName,
      launchedModelLabel,
      outcomeAlert,
      terminalId,
      activity?.status,
      activity?.toolId,
      activity?.callCount,
      activity?.danger,
    ].join("|")
  );
  const bindingText = (
    <span className={density < 4 ? "truncate min-w-0" : "sr-only"}>{binding}</span>
  );

  return (
    // Scoped so the row's tooltips share one skip-delay group and work
    // wherever the footer is mounted; the values match the app root's.
    <TooltipProvider
      delayDuration={UI_TOOLTIP_DELAY_DURATION}
      skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
      disableHoverableContent
    >
      <div
        ref={rowRef}
        className="flex items-center gap-1 border-t border-border-default shrink-0 px-1.5 py-0.5 text-2xs text-text-secondary whitespace-nowrap overflow-hidden"
      >
        <McpActivityStrip sessionId={sessionId} activity={activity} compact={density >= 3} />
        <TurnOutcomePip outcome={outcomeAlert} onDismiss={onDismissOutcome} />
        {/* This lane's terminal watches (#12491): self-gating, and where the
            user stops Daintree from waking the assistant. */}
        {terminalId && <TerminalWatchChip terminalId={terminalId} />}
        <span aria-hidden className="flex-1 min-w-2" />
        {binding !== null &&
          // A diverged worktree is recoverable in one click — switch focus back
          // to the worktree the session is pinned to. A pinned terminal with no
          // live grid target stays a quiet neutral indicator: tool calls
          // re-resolve at dispatch time and the dock-hosted chat keeps working
          // (#10792).
          (isPinnedWorktreeDiverged ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onReturnToPinnedWorktree}
                  data-footer-binding="diverged"
                  className={cn(
                    FOOTER_ITEM_CLASS,
                    "shrink-[4] text-status-warning",
                    density < 4 ? "min-w-[4.5rem]" : "min-w-0"
                  )}
                >
                  <ArrowLeftRight aria-hidden className="w-3 h-3 shrink-0" />
                  <span className="sr-only">Switch to pinned worktree: </span>
                  {bindingText}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                You're viewing another worktree. Click to switch back to {binding}
              </TooltipContent>
            </Tooltip>
          ) : (
            <StatusItem
              data-footer-binding="neutral"
              tip={`Tool calls run in ${binding}`}
              className={cn("shrink-[4]", density < 4 ? "min-w-[4.5rem]" : "min-w-0")}
            >
              <FolderGit2 aria-hidden className="w-3 h-3 shrink-0" />
              <span className="sr-only">Pinned worktree: </span>
              {bindingText}
            </StatusItem>
          ))}
        <StatusItem tip={`Assistant agent: ${agentDescription}`} className="shrink-0 gap-1">
          <AgentIcon aria-hidden className="w-3.5 h-3.5 shrink-0" />
          <span className={density < 2 ? undefined : "sr-only"}>{agentName}</span>
          {launchedModelLabel && (
            <span className={density < 1 ? undefined : "sr-only"}>· {launchedModelLabel}</span>
          )}
        </StatusItem>
      </div>
    </TooltipProvider>
  );
}
