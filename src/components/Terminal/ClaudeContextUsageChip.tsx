import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { getBuiltInRuntimeAgentId } from "@/utils/terminalType";
import { formatTokenCount } from "@/utils/formatTokenCount";
import { useClaudeContextUsage } from "@/hooks/useClaudeContextUsage";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { cn } from "@/lib/utils";
import { HEADER_CHIP_CLASS, HEADER_CHIP_FOCUS_CLASS, HEADER_CHIP_SURFACE } from "./terminalHeaderChip";

/**
 * How much context a Claude Code pane's most recent main-conversation request
 * carried, as its transcript recorded it (#16371). Self-gating: a pane that
 * isn't running Claude Code, or whose transcript gave no reading, shows
 * nothing at all.
 *
 * A count, never a share of a window. The transcript names the model but not
 * the context window it ran with, and the larger-window variants share their
 * model id with the standard ones.
 */
export function ClaudeContextUsageChip({ terminalId }: { terminalId: string }) {
  const { isClaude, agentState, generation } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[terminalId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      return {
        // Live detection first, launch affinity until it rehydrates, and
        // nothing once the agent has exited back to the shell.
        isClaude:
          pty !== undefined &&
          pty.hasPty !== false &&
          getBuiltInRuntimeAgentId(pty) === "claude",
        agentState: pty?.agentState,
        // A respawn, or Claude Code started again in the same shell, is
        // another session, and must not show the one before it.
        generation: `${pty?.startedAt ?? 0}:${pty?.agentIncarnation ?? 0}`,
      };
    })
  );
  const reading = useClaudeContextUsage(terminalId, {
    enabled: isClaude && agentState !== "exited",
    agentState,
    generation,
  });
  if (!reading) return null;

  const exact = reading.contextTokens.toLocaleString("en-US");
  const recorded = new Date(reading.recordedAt).toLocaleString();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            HEADER_CHIP_CLASS,
            HEADER_CHIP_SURFACE,
            HEADER_CHIP_FOCUS_CLASS,
            "whitespace-nowrap tabular-nums"
          )}
          role="status"
          aria-live="off"
          aria-label={`Context ${exact} tokens at the last request, read from the transcript, recorded ${recorded}`}
          tabIndex={0}
          data-testid="terminal-context-usage"
        >
          <span aria-hidden="true">{formatTokenCount(reading.contextTokens)} context</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-1">
          <div className="font-medium tabular-nums">{exact} tokens of context</div>
          <span className="text-text-secondary">
            The last request, read from the transcript,{" "}
            <TimeAgo timestamp={reading.recordedAt} verbose prefix="recorded " />
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
