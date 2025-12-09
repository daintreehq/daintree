import {
  TerminalSquare,
  LayoutGrid,
  PanelBottom,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import type { WorktreeTerminalCounts } from "@/hooks/useWorktreeTerminals";
import type { AgentState, TerminalInstance, TerminalType } from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTerminalStore } from "@/store/terminalStore";
import {
  ClaudeIcon,
  GeminiIcon,
  CodexIcon,
  NpmIcon,
  YarnIcon,
  PnpmIcon,
  BunIcon,
} from "@/components/icons";
import { getBrandColorHex } from "@/lib/colorUtils";
import { cn } from "@/lib/utils";

interface TerminalCountBadgeProps {
  counts: WorktreeTerminalCounts;
  terminals: TerminalInstance[];
  onSelectTerminal: (terminal: TerminalInstance) => void;
}

const STATE_LABELS: Record<AgentState, string> = {
  working: "running",
  idle: "idle",
  waiting: "waiting",
  completed: "done",
  failed: "error",
};

function formatStateCounts(byState: Record<AgentState, number>): string {
  const parts: string[] = [];

  const priorityOrder: AgentState[] = ["working", "waiting", "failed", "idle", "completed"];

  for (const state of priorityOrder) {
    const count = byState[state];
    if (count > 0) {
      parts.push(`${count} ${STATE_LABELS[state]}`);
    }
  }

  return parts.join(" · ");
}

function getTerminalIcon(type: TerminalType) {
  const brandColor = getBrandColorHex(type);
  const className = "w-3.5 h-3.5";

  switch (type) {
    case "claude":
      return <ClaudeIcon className={className} brandColor={brandColor} />;
    case "gemini":
      return <GeminiIcon className={className} brandColor={brandColor} />;
    case "codex":
      return <CodexIcon className={className} brandColor={brandColor} />;
    case "npm":
      return <NpmIcon className={className} />;
    case "yarn":
      return <YarnIcon className={className} />;
    case "pnpm":
      return <PnpmIcon className={className} />;
    case "bun":
      return <BunIcon className={className} />;
    default:
      return <TerminalSquare className={className} />;
  }
}

export function TerminalCountBadge({
  counts,
  terminals,
  onSelectTerminal,
}: TerminalCountBadgeProps) {
  const pingTerminal = useTerminalStore((s) => s.pingTerminal);

  if (counts.total === 0) {
    return null;
  }

  const hasNonIdleStates =
    counts.byState.working > 0 ||
    counts.byState.completed > 0 ||
    counts.byState.failed > 0 ||
    counts.byState.waiting > 0;

  const handleSelect = (term: TerminalInstance) => {
    onSelectTerminal(term);
    pingTerminal(term.id);
  };

  const contentId = "terminal-count-dropdown";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-xs text-canopy-text/60 bg-black/20 rounded-sm",
            "hover:bg-black/40 hover:text-canopy-text transition-colors cursor-pointer border border-transparent hover:border-white/10"
          )}
          onClick={(e) => e.stopPropagation()}
          aria-haspopup="menu"
          aria-controls={contentId}
          aria-label={`Active Sessions: ${counts.total} terminal${counts.total === 1 ? "" : "s"}`}
        >
          <TerminalSquare className="w-3 h-3 opacity-70" aria-hidden="true" />
          {hasNonIdleStates ? (
            <span className="font-mono">{formatStateCounts(counts.byState)}</span>
          ) : (
            <span className="font-mono">
              {counts.total} {counts.total === 1 ? "terminal" : "terminals"}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        id={contentId}
        align="start"
        className="w-64 p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-canopy-border bg-canopy-bg/50">
          <span className="text-xs font-medium text-canopy-text/70">
            Active Sessions ({terminals.length})
          </span>
        </div>
        <div className="max-h-[300px] overflow-y-auto p-1">
          {terminals.map((term) => (
            <DropdownMenuItem
              key={term.id}
              onSelect={() => handleSelect(term)}
              className="flex items-center justify-between gap-3 py-2 cursor-pointer group"
            >
              {/* LEFT SIDE: Icon + Title */}
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <div className="shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
                  {getTerminalIcon(term.type)}
                </div>
                <span className="text-sm font-medium truncate text-canopy-text/90 group-hover:text-canopy-text">
                  {term.title}
                </span>
              </div>

              {/* RIGHT SIDE: State Icons + Location */}
              <div className="flex items-center gap-3 shrink-0">
                {term.agentState === "working" && (
                  <Loader2
                    className="w-3.5 h-3.5 animate-spin text-[var(--color-state-working)]"
                    aria-label="Working"
                  />
                )}

                {term.agentState === "waiting" && (
                  <AlertCircle
                    className="w-3.5 h-3.5 text-amber-400"
                    aria-label="Waiting for input"
                  />
                )}

                {term.agentState === "failed" && (
                  <XCircle
                    className="w-3.5 h-3.5 text-[var(--color-status-error)]"
                    aria-label="Failed"
                  />
                )}

                {term.agentState === "completed" && (
                  <CheckCircle2
                    className="w-3.5 h-3.5 text-[var(--color-status-success)]"
                    aria-label="Completed"
                  />
                )}

                {/* Location Indicator (Grid vs Dock) */}
                <div
                  className="text-muted-foreground/40"
                  title={term.location === "dock" ? "Docked" : "On Grid"}
                >
                  {term.location === "dock" ? (
                    <PanelBottom className="w-3.5 h-3.5" />
                  ) : (
                    <LayoutGrid className="w-3.5 h-3.5" />
                  )}
                </div>
              </div>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
