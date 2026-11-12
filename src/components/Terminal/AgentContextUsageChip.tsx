import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import type { AgentContextUsageProvider } from "@shared/types/ipc/agentContextUsage";
import { getBuiltInRuntimeAgentId } from "@/utils/terminalType";
import { formatTokenCount } from "@/utils/formatTokenCount";
import { useAgentContextUsage } from "@/hooks/useAgentContextUsage";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { cn } from "@/lib/utils";
import { HEADER_CHIP_FOCUS_CLASS, HEADER_FACT_CLASS } from "./terminalHeaderChip";

function contextProvider(agentId: string | undefined): AgentContextUsageProvider | null {
  return agentId === "claude" || agentId === "codex" ? agentId : null;
}

/**
 * How much context an agent pane carries, as its CLI recorded it: a Claude
 * Code pane's most recent main-conversation request, from its transcript
 * (#16371), or a Codex pane's newest token count, from its rollout (#16408).
 * Self-gating: any other pane, or one whose session file gave no reading,
 * shows nothing at all.
 *
 * A share of a window only when the record itself states the window, which
 * Codex's does and Claude Code's never does: its transcript names the model,
 * and the larger-window variants share their model id with the standard ones.
 */
export function AgentContextUsageChip({ terminalId }: { terminalId: string }) {
  const { provider, agentState, generation } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[terminalId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      return {
        // Live detection first, launch affinity until it rehydrates, and
        // nothing once the agent has exited back to the shell.
        provider:
          pty !== undefined && pty.hasPty !== false
            ? contextProvider(getBuiltInRuntimeAgentId(pty))
            : null,
        agentState: pty?.agentState,
        // A respawn, or the agent started again in the same shell, is another
        // session, and must not show the one before it.
        generation: `${pty?.startedAt ?? 0}:${pty?.agentIncarnation ?? 0}`,
      };
    })
  );
  const reading = useAgentContextUsage(terminalId, {
    provider: provider ?? "claude",
    enabled: provider !== null && agentState !== "exited",
    agentState,
    generation,
  });
  if (!reading || provider === null) return null;

  const exact = reading.contextTokens.toLocaleString("en-US");
  const recorded = new Date(reading.recordedAt).toLocaleString();
  const window = reading.contextWindow;
  const percent = window === undefined ? null : Math.round((reading.contextTokens / window) * 100);
  const windowExact = window?.toLocaleString("en-US");
  const label =
    provider === "codex"
      ? `Context ${exact} tokens${
          percent === null ? "" : `, ${percent}% of a ${windowExact}-token window`
        }, read from the rollout, recorded ${recorded}`
      : `Context ${exact} tokens at the last request, read from the transcript, recorded ${recorded}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // A reading, not a control: plain text in the row's run of facts.
          // The last of them to go as the header narrows, whole, never clipped.
          className={cn(
            HEADER_FACT_CLASS,
            HEADER_CHIP_FOCUS_CLASS,
            "@max-[400px]/header:not-focus-within:hidden"
          )}
          role="status"
          aria-live="off"
          aria-label={label}
          tabIndex={0}
          data-header-fact=""
          data-testid="terminal-context-usage"
        >
          <span aria-hidden="true">
            {formatTokenCount(reading.contextTokens)} context
            {percent !== null && (
              <>
                <span className="px-1">
                  <FactSeparator />
                </span>
                {percent}%
              </>
            )}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-1">
          <div className="font-medium tabular-nums">{exact} tokens of context</div>
          {percent !== null && (
            <div className="tabular-nums">
              {percent}% of the {windowExact}-token window the rollout states
            </div>
          )}
          <span className="text-text-secondary">
            {provider === "codex"
              ? "The latest token count, read from the Codex rollout, "
              : "The last request, read from the transcript, "}
            <TimeAgo timestamp={reading.recordedAt} verbose prefix="recorded " />
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
