import type { ComponentType, ReactNode } from "react";
import { MousePointer2, RadioTower } from "lucide-react";
import { AntigravityIcon, ClaudeIcon, CodexIcon } from "@/components/icons";
import { STATE_COLORS, STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";
import {
  useSecondsSinceCue,
  useTimelineIndex,
  useTourPlayer,
  type TimelinePoint,
} from "@daintreehq/tour/react";

/** Breathing room between the last typed character and the moment it's acted on. */
const TYPING_MARGIN_S = 0.15;

/**
 * Typing speed that finishes the text before a later cue, never slower than
 * `floor`. Keeps typed prompts ahead of the Enter they lead to whatever pace
 * the narrator reads at — a re-recording can't leave a prompt half-typed.
 */
export function typingRate(
  length: number,
  startAt: number,
  finishAt: number | undefined,
  floor: number
): number {
  if (finishAt === undefined) return floor;
  const available = finishAt - startAt - TYPING_MARGIN_S;
  return available > 0 ? Math.max(floor, length / available) : floor * 4;
}

/** Scenes are authored on a fixed canvas and scaled to fit the stage. */
export const TOUR_CANVAS = { width: 640, height: 360 } as const;

export type MockAgentId = "claude" | "codex" | "antigravity";

const AGENT_ICONS: Record<MockAgentId, ComponentType<{ className?: string }>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  antigravity: AntigravityIcon,
};

const AGENT_NAMES: Record<MockAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

export function MockAgentIcon({ agent, className }: { agent: MockAgentId; className?: string }) {
  const Icon = AGENT_ICONS[agent];
  return (
    <span style={{ color: getAgentConfig(agent)?.color }} className="inline-flex shrink-0">
      <Icon className={cn("size-3.5", className)} />
    </span>
  );
}

/** Entry/exit for any element a cue reveals. Opacity survives reduced motion; the lift does not. */
export function reveal(visible: boolean, from: "below" | "above" | "left" | "none" = "below") {
  return cn(
    "transition-[opacity,translate] duration-200 ease-out reduce-motion:translate-0",
    visible ? "opacity-100 translate-0" : "opacity-0 pointer-events-none",
    !visible && from === "below" && "translate-y-2",
    !visible && from === "above" && "-translate-y-2",
    !visible && from === "left" && "-translate-x-3"
  );
}

export function MockStateGlyph({ state }: { state: AgentState | null }) {
  // Reserved box, as in the real header: the glyph never shifts the title.
  if (!state || state === "idle") return <span className="size-3.5 shrink-0" aria-hidden="true" />;
  const Icon = STATE_ICONS[state];
  return (
    <span className={cn("inline-flex size-3.5 shrink-0 items-center", STATE_COLORS[state])}>
      {/* The working spinner turns exactly as it does in a real pane header. */}
      <Icon
        className={cn(
          "size-3.5",
          state === "working" && "animate-spin-slow motion-reduce:animate-none"
        )}
      />
    </span>
  );
}

export function MockLines({
  widths,
  className,
  visibleCount,
}: {
  widths: readonly number[];
  className?: string;
  /** Reveal lines progressively, as if streaming. Defaults to all. */
  visibleCount?: number;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)} aria-hidden="true">
      {widths.map((width, i) => (
        <div
          key={i}
          className={cn(
            "h-1.5 rounded-full bg-overlay-strong transition-opacity duration-150 ease-out",
            i < (visibleCount ?? widths.length) ? "opacity-100" : "opacity-0"
          )}
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}

interface MockPaneProps {
  agent: MockAgentId;
  /** Prefix for this pane's spotlight anchors (`<anchor>-glyph`, `-armed`, `-input`). Defaults to the agent. */
  anchor?: string;
  state?: AgentState | null;
  armed?: boolean;
  focused?: boolean;
  /** Text shown in the input bar; the placeholder is used when empty. */
  input?: ReactNode;
  inputAddon?: ReactNode;
  /** Something is being dragged over the prompt bar: the real bar's drop highlight. */
  dragOver?: boolean;
  children?: ReactNode;
  className?: string;
  title?: string;
}

export function MockPane({
  agent,
  anchor = agent,
  state = null,
  armed = false,
  focused = false,
  input,
  inputAddon,
  dragOver = false,
  children,
  className,
  title,
}: MockPaneProps) {
  const name = AGENT_NAMES[agent];
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-surface-panel",
        "transition-[border-color,box-shadow] duration-150 ease-out",
        focused
          ? "border-border-interactive shadow-[var(--theme-shadow-ambient)]"
          : "border-border-default",
        className
      )}
    >
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface-panel-elevated px-2">
        <MockAgentIcon agent={agent} className="size-3" />
        <span className="truncate text-2xs font-medium text-text-primary">{title ?? name}</span>
        <span className="flex-1" />
        <span
          data-tour-anchor={`${anchor}-armed`}
          className={cn(
            "inline-flex text-category-amber-text transition-opacity duration-150 ease-out",
            armed ? "opacity-100" : "opacity-0"
          )}
        >
          <RadioTower className="size-3" aria-hidden="true" />
        </span>
        <span data-tour-anchor={`${anchor}-glyph`} className="inline-flex">
          <MockStateGlyph state={state} />
        </span>
      </div>
      <div
        data-tour-anchor={`${anchor}-body`}
        className="min-h-0 flex-1 overflow-hidden px-2.5 py-2"
      >
        {children}
      </div>
      <div className="shrink-0 px-1.5 pb-1.5">
        <div
          data-tour-anchor={`${anchor}-input`}
          className={cn(
            "flex h-5 items-center gap-2 rounded-md border bg-surface-input px-2 transition-[border-color] duration-150 ease-out",
            dragOver ? "border-border-strong bg-overlay-subtle" : "border-border-subtle"
          )}
        >
          {input ? (
            <span className="truncate text-2xs text-text-primary">{input}</span>
          ) : (
            <span className="truncate text-2xs text-text-secondary">Ask {name}</span>
          )}
          <span className="flex-1" />
          {inputAddon}
        </div>
      </div>
    </div>
  );
}

/**
 * Text that types itself out from a cue, driven by the timeline so it pauses,
 * scrubs and replays with everything else.
 */
export function MockTyping({
  cue,
  text,
  delay = 0,
  charsPerSecond = 22,
  finishBy,
  caret = true,
}: {
  cue: string;
  text: string;
  /** Seconds after the cue before the first character. */
  delay?: number;
  /** The slowest the text types; it speeds up if `finishBy` needs it to. */
  charsPerSecond?: number;
  /** A cue (plus offset) the text must be fully typed by. */
  finishBy?: TimelinePoint;
  caret?: boolean;
}) {
  const player = useTourPlayer();
  const since = useSecondsSinceCue(cue);
  if (since === null || since < delay) return null;
  const cues = player.timing.cues;
  const startAt = (cues[cue] ?? 0) + delay;
  const finishAt =
    finishBy && cues[finishBy.cue] !== undefined
      ? cues[finishBy.cue]! + (finishBy.offset ?? 0)
      : undefined;
  const rate = typingRate(text.length, startAt, finishAt, charsPerSecond);
  const shown = text.slice(0, Math.floor((since - delay) * rate));
  const done = shown.length >= text.length;
  return (
    <>
      {shown}
      {caret && !done && (
        <span className="ml-px inline-block h-2.5 w-px translate-y-0.5 bg-text-primary" />
      )}
    </>
  );
}

export interface CursorStop {
  x: number;
  y: number;
}

export interface CursorStep extends TimelinePoint {
  at: CursorStop;
  click?: boolean;
  /** A key held for this step, shown riding beside the pointer (e.g. "⇧ Shift"). */
  modifier?: string;
}

/**
 * Resolve a scripted pointer path against the timeline. A click is its own
 * step at the same spot, a beat after the arrival, so the glide finishes first.
 */
export function useMockCursor(start: CursorStop, steps: readonly CursorStep[]) {
  const index = useTimelineIndex(steps);
  const step = index >= 0 ? steps[index]! : null;
  return {
    at: step?.at ?? start,
    clickKey: step?.click ? String(index) : null,
    modifier: step?.modifier ?? null,
    visible: index >= 0,
  };
}

/** Reveal lines one by one from a cue, like output arriving. */
export function MockStreamingLines({
  cue,
  widths,
  perSecond = 6,
  delay = 0,
  className,
}: {
  cue: string;
  widths: readonly number[];
  perSecond?: number;
  delay?: number;
  className?: string;
}) {
  const since = useSecondsSinceCue(cue);
  const count = since === null || since < delay ? 0 : Math.floor((since - delay) * perSecond) + 1;
  return <MockLines widths={widths} visibleCount={count} className={className} />;
}

/**
 * The pointer that shows where to click. Moves between canvas positions with
 * one eased glide; a click is a ring that blooms once from the tip.
 */
export function MockCursor({
  at,
  clickKey,
  modifier = null,
  visible = true,
}: {
  at: CursorStop;
  /** Changing this replays the click ring; null shows none. */
  clickKey: string | null;
  modifier?: string | null;
  visible?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-0 top-0 z-40",
        "transition-[translate,opacity] duration-[450ms] ease-[cubic-bezier(0.45,0,0.2,1)] reduce-motion:transition-[opacity]",
        visible ? "opacity-100" : "opacity-0"
      )}
      style={{ translate: `${at.x}px ${at.y}px` }}
    >
      {clickKey !== null && (
        <span
          key={clickKey}
          className="tour-click-ring absolute -left-3 -top-3 size-6 rounded-full border-2 border-text-primary"
        />
      )}
      <MousePointer2
        className="relative size-4 fill-text-primary text-surface-canvas drop-shadow-sm"
        strokeWidth={1.5}
      />
      <span
        className={cn(
          "absolute left-4 top-3.5 whitespace-nowrap rounded-sm border border-border-strong bg-surface-panel-elevated px-1 py-px text-3xs font-medium text-text-primary transition-opacity duration-150 ease-out",
          modifier ? "opacity-100" : "opacity-0"
        )}
      >
        {modifier ?? ""}
      </span>
    </div>
  );
}

/** A soft outline drawn around the thing being talked about. */
export function MockFocusRing({ visible, className }: { visible: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -inset-1 rounded-lg border-2 border-text-secondary",
        "transition-opacity duration-200 ease-out",
        visible ? "opacity-60" : "opacity-0",
        className
      )}
    />
  );
}
