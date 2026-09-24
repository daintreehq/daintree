import type { ComponentType, ReactNode } from "react";
import { MousePointer2, RadioTower } from "lucide-react";
import { ClaudeIcon, CodexIcon, GeminiIcon } from "@/components/icons";
import { STATE_COLORS, STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";
import { useSecondsSinceCue, useTimelineIndex, type TimelinePoint } from "../useTourPlayer";

/** Scenes are authored on a fixed canvas and scaled to fit the stage. */
export const TOUR_CANVAS = { width: 640, height: 360 } as const;

export type MockAgentId = "claude" | "codex" | "gemini";

const AGENT_ICONS: Record<MockAgentId, ComponentType<{ className?: string }>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  gemini: GeminiIcon,
};

const AGENT_NAMES: Record<MockAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
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
      <Icon className="size-3.5" />
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
  state?: AgentState | null;
  armed?: boolean;
  focused?: boolean;
  /** Text shown in the input bar; the placeholder is used when empty. */
  input?: ReactNode;
  inputAddon?: ReactNode;
  children?: ReactNode;
  className?: string;
  title?: string;
}

export function MockPane({
  agent,
  state = null,
  armed = false,
  focused = false,
  input,
  inputAddon,
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
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-panel-elevated px-2.5">
        <MockAgentIcon agent={agent} />
        <span className="truncate text-2xs font-medium text-text-primary">{title ?? name}</span>
        <span className="flex-1" />
        <span
          className={cn(
            "inline-flex text-category-amber-text transition-opacity duration-150 ease-out",
            armed ? "opacity-100" : "opacity-0"
          )}
        >
          <RadioTower className="size-3" aria-hidden="true" />
        </span>
        <MockStateGlyph state={state} />
      </div>
      <div className="min-h-0 flex-1 px-3 py-2.5">{children}</div>
      <div className="shrink-0 px-2 pb-2">
        <div className="flex h-6 items-center gap-2 rounded-md border border-border-subtle bg-surface-input px-2">
          {input ? (
            <span className="truncate text-2xs text-text-primary">{input}</span>
          ) : (
            <span className="truncate text-2xs text-text-placeholder">Ask {name}</span>
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
  caret = true,
}: {
  cue: string;
  text: string;
  /** Seconds after the cue before the first character. */
  delay?: number;
  charsPerSecond?: number;
  caret?: boolean;
}) {
  const since = useSecondsSinceCue(cue);
  if (since === null || since < delay) return null;
  const shown = text.slice(0, Math.floor((since - delay) * charsPerSecond));
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
  visible = true,
}: {
  at: CursorStop;
  /** Changing this replays the click ring; null shows none. */
  clickKey: string | null;
  visible?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-0 top-0 z-20",
        "transition-[translate,opacity] duration-[600ms] ease-[cubic-bezier(0.45,0,0.2,1)] reduce-motion:transition-[opacity]",
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
