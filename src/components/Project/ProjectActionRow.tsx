import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";
import { STATE_COLORS, STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

export interface ProjectActionRowProps {
  activeAgentCount: number | null;
  waitingAgentCount: number | null;
  className?: string;
}

export function ProjectActionRow({
  activeAgentCount,
  waitingAgentCount,
  className,
}: ProjectActionRowProps) {
  const hasActiveAgents = activeAgentCount != null && activeAgentCount > 0;
  const hasWaitingAgents = waitingAgentCount != null && waitingAgentCount > 0;

  let state: AgentState | null = null;
  let count: number | null = null;
  let label: string | null = null;

  if (hasActiveAgents) {
    state = "working";
    count = activeAgentCount!;
    label = `${count} working agent${count === 1 ? "" : "s"}`;
  } else if (hasWaitingAgents) {
    state = "waiting";
    count = waitingAgentCount!;
    label = `${count} waiting agent${count === 1 ? "" : "s"}`;
  }

  const Icon = state ? STATE_ICONS[state] : null;

  const content = (
    <div
      className={cn(
        "flex items-center justify-end gap-1.5 shrink-0",
        "min-w-[3.25rem]",
        "text-[11px] font-mono tabular-nums leading-none text-muted-foreground/70",
        className
      )}
      aria-label={label ?? undefined}
    >
      {Icon && count != null && state && (
        <>
          <Icon
            className={cn(
              "w-3.5 h-3.5",
              STATE_COLORS[state],
              state === "working" && "animate-spin motion-reduce:animate-none"
            )}
            aria-hidden="true"
          />
          <span>{count}</span>
        </>
      )}
    </div>
  );

  if (!label) return content;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
