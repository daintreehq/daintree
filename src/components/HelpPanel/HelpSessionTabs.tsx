import { useRef, useState } from "react";
import { ChevronsUpDown, Eraser, Plus, SquareTerminal, X } from "lucide-react";
import { SpinnerCircle, InteractingCircle } from "@/components/icons";
import { BrandMark } from "@/components/icons/BrandMark";
import { getAgentConfig } from "@/config/agents";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuMeta,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { isTabCloseKey } from "@/hooks/useKeyboardTabClose";
import { pluralize } from "@/lib/pluralize";
import type { AgentState } from "@/types";
import { STATE_COLORS, STATE_ICONS, STATE_LABELS } from "@/components/Worktree/terminalStateConfig";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { NewSessionWithAgentLabel } from "./NewSessionWithAgentLabel";

/**
 * The states the header's scope switch marks on the scope that is off screen: work
 * in flight, the agent's or the user's own. The session picker draws more (see
 * {@link laneDisplayState}).
 */
type TabMarkerState = "working" | "directing";

function tabMarkerState(agentState: AgentState | null | undefined): TabMarkerState | null {
  return agentState === "working" || agentState === "directing" ? agentState : null;
}

/**
 * The activity mark the header's scope switch puts on the scope that is off screen.
 *
 * Same glyphs and tokens as an agent terminal, at 14px: these are read peripherally,
 * and at 12px a filled ring and a gapped arc collapse to "small coloured dot", which
 * leaves hue as the only carrier.
 */
export function TabStateIndicator({ agentState }: { agentState: AgentState | null | undefined }) {
  const marker = tabMarkerState(agentState);
  if (marker === "working") {
    return (
      <SpinnerCircle
        className="w-3.5 h-3.5 shrink-0 text-state-working animate-spin-slow motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  if (marker === "directing") {
    return (
      <InteractingCircle className="w-3.5 h-3.5 shrink-0 text-category-blue" aria-hidden="true" />
    );
  }
  return null;
}

/**
 * Which agent a lane runs, drawn only while the strip holds lanes on more than
 * one (#13442) — a single-agent strip has nothing to tell apart. The agent's
 * own mark in the leading 14px box a grid tab gives its terminal icon.
 */
export function TabAgentMark({ agentId }: { agentId: string }) {
  const config = getAgentConfig(agentId);
  const Icon = config?.icon ?? SquareTerminal;
  return (
    <span
      data-testid="assistant-tab-agent-mark"
      data-agent-id={agentId}
      aria-hidden="true"
      className="shrink-0 flex items-center justify-center w-3.5 h-3.5"
    >
      <BrandMark brandColor={config?.color}>
        <Icon className="w-3.5 h-3.5" />
      </BrandMark>
    </span>
  );
}

/** What a lane's agent is called where it is spoken or written out. */
function agentDisplayName(agentId: string): string {
  return getAgentConfig(agentId)?.name ?? agentId;
}

/**
 * The label, split so the part that identifies the lane cannot be truncated away.
 *
 * A fallback `Session N` label puts none of the information in the word and all of it
 * in the last token — and a plain `truncate` removes them in exactly the wrong order.
 * Splitting at the LAST space keeps the numeral whole. The tail keeps its leading space
 * via `whitespace-pre` so the two halves read as one word pair.
 *
 * An observed task title is the opposite shape: its last word is no more identifying
 * than its first, and pinning it would truncate the start of the sentence instead of
 * the end, so it truncates from the end.
 */
function SessionLabel({ label, isTaskTitle }: { label: string; isTaskTitle: boolean }) {
  const split = isTaskTitle ? -1 : label.lastIndexOf(" ");
  if (split <= 0) return <span className="truncate">{label}</span>;
  return (
    <span className="flex items-center min-w-0">
      <span className="truncate">{label.slice(0, split)}</span>
      <span className="shrink-0 whitespace-pre">{label.slice(split)}</span>
    </span>
  );
}

const EMPTY_AGENT_IDS: readonly string[] = [];

/**
 * What a lane's glyph says, by the rule an agent terminal's tab follows
 * (`getTerminalAgentDisplayState`): working, waiting or directing as observed, a live
 * agent at its prompt as waiting (ready for input), and nothing once it has exited or
 * while no agent is bound.
 */
function laneDisplayState(tab: HelpSessionTab): AgentState | undefined {
  return getTerminalAgentDisplayState(
    { isAgent: tab.isLive === true, hasExited: tab.agentState === "exited" },
    tab.agentState ?? undefined
  );
}

/**
 * A lane's state glyph in the picker: the agent terminal's own marks and hues, at the
 * 14px these are read at peripherally, where a filled ring and a gapped arc stay
 * separable.
 */
function SessionStateGlyph({ state }: { state: AgentState | undefined }) {
  if (!state) return null;
  const Icon = STATE_ICONS[state];
  return (
    <span data-agent-state={state} aria-hidden="true" className="flex shrink-0">
      <Icon
        className={cn(
          "w-3.5 h-3.5",
          STATE_COLORS[state],
          state === "working" && "animate-spin-slow motion-reduce:animate-none"
        )}
      />
    </span>
  );
}

export interface HelpSessionTab {
  slot: number;
  /** What the lane is called: the agent's trimmed task title, or `Session N`. */
  label: string;
  /**
   * The untrimmed task title when `label` came from one — what the picker shows and
   * its accessible name. Absent on a `Session N` fallback, which is also how the label
   * knows which shape it has.
   */
  fullTitle?: string | undefined;
  agentState: AgentState | null | undefined;
  /** The agent the lane runs or will resume with; absent while nothing says. */
  agentId?: string | null;
  /**
   * The lane has a live terminal and agent, or is the paused lane on screen — the
   * header's own gate for "Clear conversation".
   */
  canRestart?: boolean;
  /** A terminal and an agent are bound, so a lane at its prompt reads as ready. */
  isLive?: boolean;
}

/**
 * The DOM id the selected lane's name is published under.
 *
 * The body below the strip is a region named by the session on screen, through
 * `aria-labelledby`, so the id has to be knowable from outside this component.
 * Deriving it from one `useId` base owned by the panel does that without either
 * side holding a ref to the other, and a ref crossing a component boundary is a
 * silent React Compiler bailout in this repo.
 */
export function helpSessionTabId(idBase: string, slot: number): string {
  return `${idBase}-tab-${slot}`;
}

interface HelpSessionTabsProps {
  tabs: HelpSessionTab[];
  activeSlot: number;
  onSelect: (slot: number) => void;
  onClose: (slot: number) => void;
  /** Clear the selected lane's conversation, offered where its lane says it can. */
  onRestart?: (slot: number) => void;
  /** Whether "New session" can act. False parks the item rather than removing it. */
  canOpenSession?: boolean;
  onOpenSession?: () => void;
  /** Agents a session can be started on by name; offered only when there are several. */
  newSessionAgentIds?: readonly string[];
  /** Whether one can start, which an empty lane allows even at the ceiling. Defaults to `canOpenSession`. */
  canOpenSessionWithAgent?: boolean;
  onOpenSessionWithAgent?: (agentId: string) => void;
  /** Shared base for this strip's ids — see {@link helpSessionTabId}. */
  idBase: string;
}

/**
 * What the closed picker counts on the lanes it isn't showing: work in flight, and an
 * agent that reported it is waiting. A lane that is merely ready at its prompt shows
 * that in the list, not in the count, or every live lane would be counted.
 */
type BackgroundMarker = "working" | "waiting" | "directing";
const BACKGROUND_MARKERS: readonly BackgroundMarker[] = ["working", "waiting", "directing"];

function backgroundMarkerCounts(tabs: readonly HelpSessionTab[], activeSlot: number) {
  const counts: Record<BackgroundMarker, number> = { working: 0, waiting: 0, directing: 0 };
  for (const tab of tabs) {
    if (tab.slot === activeSlot) continue;
    const state = tab.agentState;
    if (state === "working" || state === "waiting" || state === "directing") counts[state] += 1;
  }
  return counts;
}

/**
 * The session strip: one menu button naming the session on screen, whatever the lane
 * count (#16329). It opens onto every open session, then the ways to another one, then
 * what can be done to this one.
 *
 * A tab row only worked while every title fit. Past three lanes it clipped titles to a
 * few letters and scrolled lanes out of reach, and at one lane it was a lone tab beside
 * a "+" that did the same job as a menu item. One control that is the same at every
 * count gives "which session am I in" and "give me another" a single home.
 *
 * It still carries what the tabs did. The selected lane's agent mark and state lead its
 * title, and every background lane at work stays visible without opening anything, as
 * one glyph per marker with a count. Delete and Backspace close the selected lane from
 * the closed trigger, as they did from its tab.
 *
 * A menu button rather than a listbox: the list ends in commands, which a listbox can't
 * hold, Radix owns Enter, Space and the arrow keys, the radio items announce which lane
 * is checked, and typeahead finds a lane by its title.
 */
export function HelpSessionTabs({
  tabs,
  activeSlot,
  onSelect,
  onClose,
  onRestart,
  canOpenSession = false,
  onOpenSession,
  newSessionAgentIds = EMPTY_AGENT_IDS,
  canOpenSessionWithAgent = canOpenSession,
  onOpenSessionWithAgent,
  idBase,
}: HelpSessionTabsProps) {
  // The panel hides on Escape through the escape stack, which the keybinding layer
  // pops at window capture, before Radix sees the key. An open menu registers above
  // it, so Escape closes the menu and leaves the panel where it is.
  const [menuOpenState, setIsMenuOpen] = useState(false);
  const activeTab = tabs.find((t) => t.slot === activeSlot);
  // A strip with no lane to show has no menu to close, and must not hold Escape.
  const isMenuOpen = menuOpenState && activeTab !== undefined;
  useEscapeStack(isMenuOpen, () => setIsMenuOpen(false));
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Picking a lane or starting one hands focus to the assistant's terminal, and the
  // menu's close would otherwise take it straight back to the trigger.
  const handsOffFocusRef = useRef(false);
  const handOff = (action: () => void) => () => {
    handsOffFocusRef.current = true;
    action();
  };

  if (!activeTab) return null;

  const labelId = helpSessionTabId(idBase, activeSlot);
  const descriptionId = `${labelId}-state`;
  // Lanes on one agent look exactly as they always did; only a mix is marked.
  const showAgent = new Set(tabs.flatMap((t) => (t.agentId ? [t.agentId] : []))).size > 1;
  const agentName = showAgent && activeTab.agentId ? agentDisplayName(activeTab.agentId) : null;
  const activeTitle = activeTab.fullTitle ?? activeTab.label;
  // The agent joins the name rather than the description: it is what tells two
  // `Session N` lanes apart, which is the job of a name.
  const title = agentName ? `${activeTitle} — ${agentName}` : activeTitle;
  const activeState = laneDisplayState(activeTab);
  const marker = activeState ? STATE_LABELS[activeState] : null;
  const background = backgroundMarkerCounts(tabs, activeTab.slot);
  const backgroundSummary = BACKGROUND_MARKERS.flatMap((kind) =>
    background[kind] > 0 ? [`${pluralize(background[kind], "other session")} ${kind}`] : []
  ).join(", ");
  const description = [marker, backgroundSummary].filter(Boolean).join(", ");
  const hasBackground = backgroundSummary !== "";
  // A title the trigger may clip, an agent mark, or activity on other lanes: each is
  // something the pointer can ask about. A bare `Session N` has nothing to add.
  const tipNamesSession = activeTab.fullTitle !== undefined || agentName !== null;
  const hasTip = tipNamesSession || hasBackground;
  const atLimit = tabs.length >= MAX_ASSISTANT_SLOTS;
  const hasAgentItems = !!onOpenSessionWithAgent && newSessionAgentIds.length > 1;
  const canRestart = !!onRestart && !!activeTab.canRestart;
  // One column per kind of leading glyph across every row, so titles share a left edge
  // whether or not their lane is busy.
  const stateColumn = tabs.some((t) => laneDisplayState(t) !== undefined);
  const capReason = (
    <span className="sr-only">, {MAX_ASSISTANT_SLOTS} sessions is the maximum for one project</span>
  );

  return (
    <div
      data-session-strip=""
      className="flex min-w-0 shrink-0 items-center px-1.5 py-1 border-b border-border-default"
    >
      <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <Tooltip open={hasTip && !isMenuOpen ? undefined : false}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                data-session-picker=""
                data-testid="assistant-session-picker"
                aria-label={title}
                aria-describedby={description ? descriptionId : undefined}
                aria-keyshortcuts="Delete"
                onKeyDown={(e) => {
                  // The trigger outlives every lane it closes, so a held key would
                  // close them one after another.
                  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
                  if (!isTabCloseKey(e.key)) return;
                  e.preventDefault();
                  onClose(activeTab.slot);
                }}
                className={cn(
                  "group/session flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2",
                  "text-xs font-medium text-text-primary select-none cursor-pointer",
                  // A resting fill, so the row reads as a control and not as a heading
                  // with a chevron after it. The transparent border is the boundary
                  // forced colours draw once the fill is gone.
                  // Open is read from the menu's own state: the tooltip trigger sets
                  // its own `data-state` on the same element. A control's hover step,
                  // not the highlighted-row fill: this is a button, not a row.
                  "border border-transparent transition-colors duration-150 ease-out",
                  isMenuOpen ? "bg-overlay-hover" : "bg-overlay-soft hover:bg-overlay-hover",
                  "outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
                )}
              >
                {agentName && activeTab.agentId && <TabAgentMark agentId={activeTab.agentId} />}
                <SessionStateGlyph state={activeState} />
                <span className="flex min-w-0 flex-1 items-center">
                  <SessionLabel
                    label={activeTitle}
                    isTaskTitle={activeTab.fullTitle !== undefined}
                  />
                </span>
                {/* The other lanes, said once for all of them and set apart from the
                    selected lane's own state: a lone spinner beside the chevron read as
                    this session working. */}
                {hasBackground && (
                  <span
                    data-testid="assistant-session-picker-background"
                    aria-hidden="true"
                    className="flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border-default px-1.5 text-2xs tabular-nums text-text-secondary"
                  >
                    {BACKGROUND_MARKERS.map((kind) =>
                      background[kind] > 0 ? (
                        <span key={kind} data-marker={kind} className="flex items-center gap-0.5">
                          <SessionStateGlyph state={kind} />
                          {background[kind]}
                        </span>
                      ) : null
                    )}
                  </span>
                )}
                {/* A navigation switcher's glyph, as on the project pill: this changes
                    what the panel shows rather than setting a value. */}
                <ChevronsUpDown
                  className={cn(
                    "size-3.5 shrink-0 transition-colors duration-150 ease-out",
                    isMenuOpen
                      ? "text-text-primary"
                      : "text-text-secondary group-hover/session:text-text-primary"
                  )}
                  aria-hidden="true"
                />
                {/* The body's name. */}
                <span id={labelId} className="sr-only">
                  {title}
                </span>
                {description && (
                  <span id={descriptionId} className="sr-only">
                    {description}
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {hasTip && (
            <TooltipContent side="bottom" align="start">
              {/* A bare `Session N` is already on the trigger in full. */}
              {tipNamesSession && <span className="block">{title}</span>}
              {hasBackground && (
                <span className={cn("block", tipNamesSession && "text-text-secondary")}>
                  {backgroundSummary}
                </span>
              )}
            </TooltipContent>
          )}
        </Tooltip>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(e) => {
            if (!handsOffFocusRef.current) return;
            handsOffFocusRef.current = false;
            // Kept only where something outside the menu took focus. A lane still
            // launching has no terminal yet, and then the shared restore puts focus
            // back on the trigger with the ring the way the menu was used.
            const current = document.activeElement;
            const tookFocus =
              current instanceof HTMLElement &&
              current !== document.body &&
              current !== triggerRef.current &&
              current.isConnected &&
              !current.closest('[role="menu"]');
            if (tookFocus) e.preventDefault();
          }}
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[200px] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
        >
          <DropdownMenuRadioGroup
            aria-label="Open sessions"
            value={String(activeTab.slot)}
            onValueChange={(value) => handOff(() => onSelect(Number(value)))()}
          >
            {tabs.map((tab) => {
              const itemState = laneDisplayState(tab);
              const itemMarker = itemState ? STATE_LABELS[itemState] : null;
              const itemAgent = showAgent && tab.agentId ? agentDisplayName(tab.agentId) : null;
              const itemTitle = tab.fullTitle ?? tab.label;
              return (
                <DropdownMenuRadioItem
                  key={tab.slot}
                  value={String(tab.slot)}
                  textValue={itemTitle}
                  // Glyphs and the check sit on a wrapped title's first line, not
                  // between its lines.
                  className="items-start [&>span:first-child]:top-[7px]"
                >
                  <span className="flex min-w-0 flex-1 items-start gap-1.5">
                    {showAgent && (
                      <span className="mt-px flex shrink-0">
                        {tab.agentId ? (
                          <TabAgentMark agentId={tab.agentId} />
                        ) : (
                          <span className="size-3.5" />
                        )}
                      </span>
                    )}
                    {stateColumn && (
                      <span className="mt-px flex size-3.5 shrink-0">
                        <SessionStateGlyph state={itemState} />
                      </span>
                    )}
                    {/* Wrapped, never truncated: this list is where a title is read whole. */}
                    <span className="min-w-0 whitespace-normal break-words">{itemTitle}</span>
                    {itemAgent && <span className="sr-only">, {itemAgent}</span>}
                    {itemMarker && <span className="sr-only">, {itemMarker}</span>}
                  </span>
                  {itemAgent && <DropdownMenuMeta>{itemAgent}</DropdownMenuMeta>}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
          {(onOpenSession || hasAgentItems) && <DropdownMenuSeparator />}
          {onOpenSession && (
            <DropdownMenuItem
              disabled={!canOpenSession}
              onSelect={handOff(onOpenSession)}
              // The row dims its own label rather than everything in it, so the reason
              // beside it stays readable.
              className="data-[disabled]:opacity-100"
            >
              <span className={cn("flex items-center", !canOpenSession && "opacity-50")}>
                <Plus data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                New session
              </span>
              {/* A disabled item can't carry a tooltip, so the reason sits on the row. */}
              {atLimit && !canOpenSession && (
                <>
                  <DropdownMenuMeta>{`${tabs.length} of ${MAX_ASSISTANT_SLOTS} open`}</DropdownMenuMeta>
                  {capReason}
                </>
              )}
            </DropdownMenuItem>
          )}
          {hasAgentItems &&
            newSessionAgentIds.map((agentId) => (
              <DropdownMenuItem
                key={agentId}
                disabled={!canOpenSessionWithAgent}
                onSelect={handOff(() => onOpenSessionWithAgent?.(agentId))}
              >
                <NewSessionWithAgentLabel agentId={agentId} />
                {atLimit && !canOpenSessionWithAgent && capReason}
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          {/* Hidden rather than disabled where the lane has nothing to restart, as the
              header's overflow item is. */}
          {canRestart && (
            <DropdownMenuItem destructive onSelect={() => onRestart?.(activeTab.slot)}>
              <Eraser data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Clear conversation
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => onClose(activeTab.slot)}>
            <X data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Close session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
