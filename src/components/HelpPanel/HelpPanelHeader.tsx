import { ChevronRight, CircleHelp, CircleStop, Ellipsis, Plus } from "lucide-react";
import { SpinnerCircle, HollowCircle, InteractingCircle } from "@/components/icons";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";

// Tier-1 ambient indicator (per CLAUDE.md Runtime Signals): surfaces the
// in-flight assistant state next to the header title so the user can read it
// without watching the terminal. Only the actionable triad — working,
// directing, waiting — earns a marker; idle/completed/exited stay quiet.
function AssistantHeaderStateIndicator({
  agentState,
}: {
  agentState: AgentState | null | undefined;
}) {
  if (agentState === "working") {
    return (
      <span
        data-testid="assistant-header-state-indicator"
        data-agent-state="working"
        aria-label="Assistant is working"
        role="status"
        className="ml-1.5 inline-flex shrink-0"
      >
        <SpinnerCircle className="w-3.5 h-3.5 text-state-working animate-spin-slow motion-reduce:animate-none" />
      </span>
    );
  }
  if (agentState === "directing") {
    return (
      <span
        data-testid="assistant-header-state-indicator"
        data-agent-state="directing"
        aria-label="Assistant is directing"
        role="status"
        className="ml-1.5 inline-flex shrink-0"
      >
        <InteractingCircle className="w-3.5 h-3.5 text-category-blue" />
      </span>
    );
  }
  if (agentState === "waiting") {
    return (
      <span
        data-testid="assistant-header-state-indicator"
        data-agent-state="waiting"
        aria-label="Assistant is waiting"
        role="status"
        className="ml-1.5 inline-flex shrink-0"
      >
        <HollowCircle className="w-3.5 h-3.5 text-state-waiting" />
      </span>
    );
  }
  return null;
}

interface HelpPanelHeaderProps {
  agentState: AgentState | null | undefined;
  canStartNewSession: boolean;
  canEndSession: boolean;
  onNewSession: () => void;
  onEndSession: () => void;
  onOpenDocs: () => void;
  onClose: () => void;
  isFocused?: boolean;
}

export function HelpPanelHeader({
  agentState,
  canStartNewSession,
  canEndSession,
  onNewSession,
  onEndSession,
  onOpenDocs,
  onClose,
  isFocused = false,
}: HelpPanelHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 px-3 py-2 border-b border-daintree-border shrink-0 transition-colors",
        // Title-bar lift owns the surface-highlight for the focused assistant
        // region. Uses `--color-surface-highlight` (= theme-aware
        // `surface-panel-elevated`) — the same token grid panels swap to via
        // `.terminal-selected`, so the visual weight matches a selected
        // panel's title bar across every theme. Scoping the fill here (not
        // on the aside via `.assistant-focused`) keeps the launching
        // skeleton, empty state, and any future no-terminal content anchored
        // to `bg-daintree-bg`. Neutral lift — no accent — per the
        // single-anchor-per-region rule.
        isFocused && "bg-[var(--color-surface-highlight)] border-b-[var(--border-overlay)]"
      )}
    >
      <div className="flex items-center min-w-0 flex-1">
        <DaintreeIcon className="w-4 h-4 text-daintree-text/50 shrink-0" />
        <span className="ml-1.5 text-xs font-medium text-daintree-text/70 truncate">
          Daintree Assistant
        </span>
        <AssistantHeaderStateIndicator agentState={agentState} />
      </div>
      {canStartNewSession && (
        <button
          type="button"
          onClick={onNewSession}
          className="p-1 rounded-[var(--radius-sm)] text-daintree-text/50 hover:text-daintree-text hover:bg-tint/8 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
          aria-label="Start new session"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
      {/* Secondary + destructive actions live in the overflow, per the 3-icon
          header budget — and Stop must not sit adjacent to the benign hide
          chevron (destructive-adjacency misfire risk). */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="p-1 rounded-[var(--radius-sm)] text-daintree-text/50 hover:text-daintree-text hover:bg-tint/8 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
            aria-label="More actions"
            aria-haspopup="menu"
            data-testid="assistant-header-more"
          >
            <Ellipsis className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          <DropdownMenuItem onSelect={onOpenDocs}>
            <CircleHelp className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Open docs
          </DropdownMenuItem>
          {canEndSession && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onEndSession}>
                <CircleStop className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Stop assistant
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={onClose}
        className="p-1 rounded-[var(--radius-sm)] text-daintree-text/50 hover:text-daintree-text hover:bg-tint/8 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        aria-label="Hide Daintree Assistant"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
