import { useState, type Ref } from "react";
import { ChevronRight, CircleHelp, CircleStop, Ellipsis, Eraser, History } from "lucide-react";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SurfaceHeader, SURFACE_HEADER_FOCUS_LIFT_CLASS } from "@/components/ui/SurfaceHeader";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { NewSessionWithAgentLabel } from "./NewSessionWithAgentLabel";
import { TabStateIndicator } from "./HelpSessionTabs";
import type { AgentState } from "@/types";
import type { DisplayIdentity } from "@shared/types/displayIdentity";
import { displayIdentityLabel, displayIdentityName } from "@shared/utils/displayIdentity";

/** The panel-chrome action button: `icon-xs` (24px target) with a 14px glyph. */
export const HEADER_ACTION_CLASS = "[&_svg]:size-3.5";

/** Which assistant the panel shows: this project's lanes, or the installation's one global run. */
export type AssistantScope = "project" | "global";

/**
 * What the active lane's state is called when it is spoken rather than drawn:
 * the states the strip marks, and no others. A lane at its prompt is never
 * announced as waiting, since only an ask Canopy read is, and Canopy never
 * reads an assistant.
 */
const SPOKEN_STATE: Partial<Record<NonNullable<AgentState>, string>> = {
  working: "is working",
  directing: "is directing",
};

/**
 * The active lane's state, announced but not drawn.
 *
 * The header used to draw the same 14px marker the session strip draws, for the same
 * lane, one row apart — so a working session put two identical spinners on screen and
 * left the user to work out whether the panel or the conversation was busy. The strip
 * is now always present and its marker is per-lane, which is strictly more information
 * in a more specific place, so the visible duplicate is gone.
 *
 * What does not survive that deletion on its own is the announcement. A marker in the
 * strip reaches assistive tech through `aria-describedby`, which is read when a tab
 * takes focus and not when the state CHANGES — whereas the mark this replaces was a
 * `role="status"` live region that spoke on every transition. Keeping one here, with
 * no visual presence, preserves that for the lane on screen.
 */
function AssistantStateAnnouncer({
  agentState,
  name,
}: {
  agentState: AgentState | null | undefined;
  name: string;
}) {
  const state = agentState ? SPOKEN_STATE[agentState] : undefined;
  const spoken = state ? `${name} ${state}` : undefined;
  return (
    <span
      data-testid="assistant-header-state-announcer"
      data-agent-state={agentState ?? undefined}
      role="status"
      className="sr-only"
    >
      {spoken ?? ""}
    </span>
  );
}

/** The lane most worth a glance while its scope is off screen, and every lane's state in words. */
export interface ScopeActivity {
  agentState: AgentState;
  /** "Session 2 directing, Session 3 working" — what was seen, lane by lane. */
  summary: string;
}

/**
 * Most worth a glance first. Only the states the strip marks: a lane at its
 * prompt, idle or exited draws nothing there, so it isn't named here either.
 */
const LANE_STATE_RANK: Partial<Record<NonNullable<AgentState>, number>> = {
  directing: 0,
  working: 1,
};

export function summarizeLaneActivity(
  tabs: readonly { label: string; agentState: AgentState | null | undefined }[]
): ScopeActivity | null {
  const marked = tabs.flatMap((tab) => {
    const rank = tab.agentState ? LANE_STATE_RANK[tab.agentState] : undefined;
    return tab.agentState && rank !== undefined
      ? [{ label: tab.label, state: tab.agentState, rank }]
      : [];
  });
  if (marked.length === 0) return null;
  const top = marked.reduce((a, b) => (b.rank < a.rank ? b : a));
  return {
    agentState: top.state,
    summary: marked.map((lane) => `${lane.label} ${lane.state}`).join(", "),
  };
}

/**
 * One scope's segment. A persona replaces the scope's word as the label, so
 * the tooltip and the accessible name keep saying which scope it is.
 */
function scopeOption(
  value: AssistantScope,
  word: string,
  description: string,
  identity: DisplayIdentity | undefined,
  activity: ScopeActivity | null
): SegmentedRadioOption<AssistantScope> {
  const label = displayIdentityLabel(identity, word);
  const named = label !== word;
  const scopeName = named ? `${label}, ${word.toLowerCase()} assistant` : word;
  return {
    value,
    label,
    tooltip: activity ? activity.summary : named ? `${label}: ${description}` : description,
    ariaLabel: activity ? `${scopeName}, ${activity.summary}` : named ? scopeName : undefined,
    trailing: activity ? <TabStateIndicator agentState={activity.agentState} /> : undefined,
  };
}

function scopeOptions(
  scope: AssistantScope,
  projectActivity: ScopeActivity | null,
  globalActivity: ScopeActivity | null,
  projectIdentity: DisplayIdentity | undefined,
  globalIdentity: DisplayIdentity | undefined
): SegmentedRadioOption<AssistantScope>[] {
  // Only the scope NOT on screen carries a mark: the one on screen shows its
  // own state where its conversation is.
  const project = scope === "global" ? projectActivity : null;
  const global = scope === "project" ? globalActivity : null;
  return [
    scopeOption("project", "Project", "This project's sessions", projectIdentity, project),
    scopeOption(
      "global",
      "Global",
      "One assistant for every project and window",
      globalIdentity,
      global
    ),
  ];
}

interface HelpPanelHeaderProps {
  /** The state of the lane on screen. Announced only — the strip draws it. */
  agentState: AgentState | null | undefined;
  scope: AssistantScope;
  onScopeChange: (scope: AssistantScope) => void;
  /**
   * Where the global pane puts its own controls while it is shown. The header
   * keeps panel-level actions; the global run's agent and menu are the pane's,
   * drawn here so the global scope costs one row instead of three.
   */
  globalControlsRef?: Ref<HTMLDivElement>;
  /** Background lane activity, marked on the Project option while Global is shown. */
  projectActivity?: ScopeActivity | null;
  /** The global run's observed activity, marked on the Global option while Project is shown. */
  globalActivity?: ScopeActivity | null;
  /** The name and emoji the person gave this project's assistant (#16213). */
  projectIdentity?: DisplayIdentity;
  /** The name and emoji the person gave the global assistant (#16213). */
  globalIdentity?: DisplayIdentity;
  canRestartConversation: boolean;
  canEndSession: boolean;
  onRestartConversation: () => void;
  onEndSession: () => void;
  onResumePastSession: () => void;
  onOpenDocs: () => void;
  /** Whether opening the panel starts a session by itself. */
  autoLaunchEnabled: boolean;
  onAutoLaunchEnabledChange: (enabled: boolean) => void;
  onClose: () => void;
  isFocused?: boolean;
  /** Agents a session can be started on by name; offered only when there are several. */
  newSessionAgentIds?: readonly string[];
  /** False at the session ceiling, which parks the agent items rather than hiding them. */
  canStartNewSession?: boolean;
  onNewSessionWithAgent?: (agentId: string) => void;
}

export function HelpPanelHeader({
  agentState,
  scope,
  onScopeChange,
  globalControlsRef,
  projectActivity = null,
  globalActivity = null,
  projectIdentity,
  globalIdentity,
  canRestartConversation,
  canEndSession,
  onRestartConversation,
  onEndSession,
  onResumePastSession,
  onOpenDocs,
  autoLaunchEnabled,
  onAutoLaunchEnabledChange,
  onClose,
  isFocused = false,
  newSessionAgentIds = [],
  canStartNewSession = false,
  onNewSessionWithAgent,
}: HelpPanelHeaderProps) {
  // The panel closes on Escape through the escape stack, which the global
  // keybinding layer pops at window capture — before Radix's menu sees the key.
  // An open overflow menu registers above the panel so Escape closes the menu
  // first, not the whole assistant.
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  useEscapeStack(isMenuOpen, () => setIsMenuOpen(false));
  return (
    <SurfaceHeader
      density="compact"
      className={cn(
        "gap-1 transition-colors",
        // The same lift a focused grid pane's title bar takes, so the assistant
        // and the pane beside it read as one family when either has the
        // keyboard. The divider steps up to `--border-overlay` to match the
        // `.terminal-selected` header rule in index.css — through the
        // `border-overlay` class, because the frame's `.border-divider` is a
        // custom rule that outranks an arbitrary `border-b-[…]` colour. Scoped to the header
        // (not the aside) so the launching skeleton, the empty state and any
        // no-terminal content stay on `bg-surface-canvas`. Neutral lift, no
        // accent, per the single-anchor-per-region rule.
        isFocused && [SURFACE_HEADER_FOCUS_LIFT_CLASS, "border-overlay"]
      )}
    >
      {/* The scope switch is the panel's title. A static "Daintree Assistant" label
          spent the row's widest stretch saying what the toolbar button already
          said, while the global run sat in the session strip as a peer of the
          lanes it is not one of: it has no close, no "+", and no siblings. */}
      <div className={cn("flex items-center gap-2 min-w-0", scope === "project" && "flex-1")}>
        <DaintreeIcon className="w-4 h-4 text-text-secondary shrink-0" />
        <SegmentedRadioGroup
          density="compact"
          aria-label="Assistant scope"
          options={scopeOptions(
            scope,
            projectActivity,
            globalActivity,
            projectIdentity,
            globalIdentity
          )}
          value={scope}
          onChange={onScopeChange}
          testId="assistant-scope"
          // A persona's name is as long as the person made it.
          className="min-w-0 shrink"
        />
        <AssistantStateAnnouncer
          agentState={agentState}
          name={displayIdentityName(projectIdentity, "Assistant")}
        />
      </div>
      {/* The header carries panel-level actions only. Anything scoped to ONE
          conversation belongs to the strip, which is where the sessions are.

          The `+` that used to sit here is gone. It restarted the current
          conversation, while the strip a row below grew a control that opened
          another session — two plus-shaped affordances a few pixels apart doing
          different things, and only the destructive one was visible. Restarting
          is now a named overflow item, and a new session lives in the strip's
          session menu. */}
      {scope === "global" && (
        <div ref={globalControlsRef} className="contents" data-testid="assistant-global-controls" />
      )}
      {scope === "project" && (
        <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={HEADER_ACTION_CLASS}
                  aria-label="More actions"
                  aria-haspopup="menu"
                  data-testid="assistant-header-more"
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">More actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            {/* Named for what it does to the conversation, not for what it does to
              the session. "Start new session" read as "give me another session",
              which is the strip's "New session" — and this is the one that
              throws the current conversation away. Opening a parallel session
              is NOT mirrored here: the strip's menu is its single home. Opening
              one on a particular agent is (#13442). */}
            {canRestartConversation && (
              <>
                <DropdownMenuItem destructive onSelect={onRestartConversation}>
                  <Eraser className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                  Clear conversation
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {onNewSessionWithAgent &&
              newSessionAgentIds.length > 1 &&
              newSessionAgentIds.map((agentId) => (
                <DropdownMenuItem
                  key={agentId}
                  disabled={!canStartNewSession}
                  onSelect={() => onNewSessionWithAgent(agentId)}
                >
                  <NewSessionWithAgentLabel agentId={agentId} />
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem onSelect={onResumePastSession}>
              <History className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Resume a past session…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenDocs}>
              <CircleHelp className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Open docs
            </DropdownMenuItem>
            {/* The one place auto-start is turned on or off, so its state is
                visible from the panel it governs. Starting a session never
                turns it on by the way (#14976). */}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={autoLaunchEnabled}
              onCheckedChange={onAutoLaunchEnabledChange}
              data-testid="assistant-auto-launch-toggle"
            >
              Start when the panel opens
            </DropdownMenuCheckboxItem>
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
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            className={HEADER_ACTION_CLASS}
            aria-label="Hide Daintree Assistant"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Hide Daintree Assistant</TooltipContent>
      </Tooltip>
    </SurfaceHeader>
  );
}
