import {
  isValidElement,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Anser from "anser";
import { ChevronDown, GripVertical, Send } from "lucide-react";
import type { ActionDanger, ActionId } from "@shared/types/actions";
import type { PluginAgentPane, PluginSendToAgentRefusalReason } from "@shared/types/plugin";
import type {
  PluginActionButtonProps,
  PluginActionDispatchOutcome,
  PluginActionMenuItem,
  PluginAgentAvatarProps,
  PluginAgentBadgeProps,
  PluginAgentPickerChoice,
  PluginAgentPickerProps,
  PluginAgentState,
  PluginAgentStateIndicatorProps,
  PluginContextDragSourceProps,
  PluginKeyHintsProps,
  PluginSendToAgentButtonProps,
  PluginSendToAgentOutcome,
  PluginSendToAgentRequest,
  PluginShortcutHintProps,
  PluginTerminalSnapshotProps,
} from "@shared/types/plugin-sdk-react";
import { resolveEffectiveActionDanger } from "@shared/utils/effectiveActionDanger";
import {
  setAgentContextDragData,
  validateAgentContextPayload,
} from "@shared/utils/agentContextDrag";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { getAgentConfig } from "@/config/agents";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { BrandMark } from "@/components/icons";
import { DEFAULT_PANEL_ICON } from "@/components/icons/pluginIconRegistry";
import {
  ROW_REFUSAL_LABEL,
  buildSendToAgentRows,
  filterSendToAgentRows,
} from "@/components/Plugin/sendToAgentRows";
import {
  STATE_COLORS,
  STATE_ICONS,
  agentStateDotColor,
} from "@/components/Worktree/terminalStateConfig";
import { ARIA_DISABLED_CLASSES } from "@/components/ui/ariaDisabled";
import { Badge } from "@/components/ui/badge";
import { DRAG_GRIP_CLASS, DRAG_GRIP_ICON_CLASS } from "@/components/ui/dragGripStyles";
import { Button } from "@/components/ui/button";
import { KbdChord, KBD_CLASS } from "@/components/ui/Kbd";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import {
  TOOLTIP_CARD_PADDING,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { SHORTCUT_ROW_GAP } from "@/lib/tooltipShortcut";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { formatTimeAgo } from "@/utils/timeAgo";
import { logError } from "@/utils/logger";
import { useNow } from "../../../packages/plugin-sdk/src/react/useNow";
import { timeAgoTick } from "./PluginKitDates";
import { showPluginViewToast } from "./PluginKitHooksFeedback";
import { renderIconSource } from "./PluginKitIcons";
import {
  ALIGNS,
  SIDES,
  content,
  field,
  fn,
  nonEmpty,
  oneOf,
  pickRootProps,
  PluginStyleScope,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { useKitOverlayZClass, usePluginKitOwner } from "./kitScope";

// Components that speak Daintree's own concepts. Each reads only what a plugin
// view may already reach: the action catalogue and dispatch (`host.actions` and
// `host.dispatch`, which need no capability and run here with the "plugin"
// source, so the same deny list and confirm gate apply), the static agent
// registry, and data the view's worker hands it. Nothing here reads terminals,
// panels or agent state on the plugin's behalf.

const AGENT_STATES = ["idle", "working", "waiting", "directing", "completed", "exited"] as const;

// ---------------------------------------------------------------------------
// Actions

const UNKNOWN_ACTION_REASON = "Not available in this version of Daintree";
const PLUGIN_BLOCKED_REASON = "Plugins can't run this action";
const CONFIRM_REASON = "Asks for confirmation, so run it from Daintree itself";
const DISABLED_FALLBACK_REASON = "Not available right now";

export interface KitActionState {
  /** The action is registered here. */
  known: boolean;
  title: string;
  /** The user's current binding for it, if any. */
  combo: string | undefined;
  /** A dispatch from a plugin would get past every gate it can know of now. */
  runnable: boolean;
  reason: string | undefined;
}

/**
 * What a plugin dispatch of `actionId` would meet, read the way
 * `ActionService.dispatch` gates the "plugin" source: restricted and
 * deny-listed actions refuse, a confirm-gated one (after its arguments raise
 * it) refuses, and a disabled one says why. `revision` only busts the React
 * Compiler's cache when the caller wants a fresh read.
 */
export function readActionState(actionId: string, args: unknown, revision = 0): KitActionState {
  void revision;
  const id = actionId as ActionId;
  const combo = keybindingService.getEffectiveCombo(actionId) || undefined;
  let entry;
  try {
    entry = actionService.get(id, undefined, { includeSchemas: false });
  } catch {
    entry = null;
  }
  // A restricted action is invisible to plugins (`host.actions.get` answers
  // null for it), so the kit does not hand its title to a view either.
  if (!entry || entry.danger === "restricted") {
    return { known: false, title: "", combo, runnable: false, reason: UNKNOWN_ACTION_REASON };
  }
  const blocked = (reason: string): KitActionState => ({
    known: true,
    title: entry.title,
    combo,
    runnable: false,
    reason,
  });
  if (actionService.deniesPluginDispatch(id)) return blocked(PLUGIN_BLOCKED_REASON);
  let danger: ActionDanger = entry.danger;
  try {
    danger = resolveEffectiveActionDanger(actionId, entry.danger, "plugin", args);
  } catch {
    // The declared danger stands; dispatch re-checks with validated arguments.
  }
  if (danger !== "safe")
    return blocked(danger === "confirm" ? CONFIRM_REASON : PLUGIN_BLOCKED_REASON);
  if (!entry.enabled) return blocked(nonEmpty(entry.disabledReason) ?? DISABLED_FALLBACK_REASON);
  return { known: true, title: entry.title, combo, runnable: true, reason: undefined };
}

/** Runs an action as `host.dispatch` would, never throwing. */
export async function dispatchActionFromView(
  actionId: string,
  args: unknown
): Promise<PluginActionDispatchOutcome> {
  try {
    const result = await actionService.dispatch(actionId as ActionId, args, { source: "plugin" });
    if (result.ok) return { ok: true };
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  } catch (error) {
    return {
      ok: false,
      error: { code: "EXECUTION_ERROR", message: formatErrorMessage(error, "Action failed") },
    };
  }
}

/** Calls a plugin callback; a throw is the plugin's bug, logged rather than let loose. */
function callPlugin<A extends unknown[]>(callback: ((...args: A) => void) | undefined, ...args: A) {
  if (!callback) return;
  try {
    callback(...args);
  } catch (error) {
    logError("[plugin-ui] a callback threw", error);
  }
}

/**
 * Hands an outcome to the plugin, or when it asked for none says a real
 * failure in the plugin's name. A `DISABLED` refusal needs no toast (the
 * control redraws disabled with the reason), nor does a failure the action
 * already reported itself.
 */
function reportOutcome(
  owner: string | null,
  actionId: string,
  title: string,
  outcome: PluginActionDispatchOutcome,
  onDispatched: ((outcome: PluginActionDispatchOutcome) => void) | undefined
): void {
  if (onDispatched) {
    callPlugin(onDispatched, outcome);
    return;
  }
  if (outcome.ok || outcome.error?.code === "DISABLED") return;
  if (
    outcome.error?.code === "EXECUTION_ERROR" &&
    actionService.selfNotifiesOnExecutionError(actionId as ActionId)
  ) {
    return;
  }
  showPluginViewToast(owner, {
    tone: "error",
    message: `Couldn't run ${title || "the action"}: ${outcome.error?.message ?? "it failed"}`,
  });
}

/**
 * Whether the component is still mounted, for work that settles later: a
 * dispatch or a send that outlives its view must not report into it.
 */
function useMounted(): { readonly current: boolean } {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/** A revision that moves when the user rebinds a key, and on demand. */
function useActionRevision(): [number, () => void] {
  const [revision, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => keybindingService.subscribe(() => bump()), []);
  return [revision, () => bump()];
}

function subscribeKeybindings(listener: () => void): () => void {
  return keybindingService.subscribe(listener);
}

/** The user's current binding for an action, kept current. */
function useEffectiveCombo(actionId: string | undefined): string | undefined {
  const combo = useSyncExternalStore(subscribeKeybindings, () =>
    actionId ? (keybindingService.getEffectiveCombo(actionId) ?? "") : ""
  );
  return combo || undefined;
}

const ICON_BUTTON_SIZE = { default: "icon", sm: "icon-sm", xs: "icon-xs" } as const;
const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "subtle",
  "contrast",
  "destructive",
  "ghost-danger",
  "link",
  "pill",
] as const;

/** A tooltip's label and keys on one row, the grammar of every app tooltip. */
function LabelWithKeys({ label, combo }: { label: ReactNode; combo: string | undefined }) {
  if (!combo) return <span>{label}</span>;
  return (
    <span className={cn("flex w-full items-center justify-between", SHORTCUT_ROW_GAP)}>
      <span>{label}</span>
      <KbdChord shortcut={combo} />
    </span>
  );
}

function KitActionButton(props: PluginActionButtonProps) {
  const {
    actionId,
    args,
    children,
    icon,
    iconOnly,
    variant,
    size,
    whenUnavailable,
    disabled,
    disabledReason,
    tooltipSide,
    onDispatched,
    className,
    ...rest
  } = props;
  const owner = usePluginKitOwner();
  const overlayZ = useKitOverlayZClass();
  const reasonId = useId();
  const [revision, refresh] = useActionRevision();
  const [pending, setPending] = useState(false);
  const mounted = useMounted();
  const id = nonEmpty(actionId);
  if (!id) return null;

  const state = readActionState(id, args, revision);
  const given = content(children);
  const label = given ?? (state.title || undefined);
  if (label === undefined) return null;
  if (!state.runnable && whenUnavailable === "hide") return null;
  const textLabel = typeof given === "string" ? given : state.title || id;
  const authorBlocked = disabled === true;
  const blocked = authorBlocked || !state.runnable;
  const reason = authorBlocked ? nonEmpty(disabledReason) : state.reason;
  const glyph = renderIconSource(icon);
  const compact = iconOnly === true && glyph !== null;

  const onClick = () => {
    if (blocked || pending) return;
    setPending(true);
    void dispatchActionFromView(id, args).then((outcome) => {
      if (!mounted.current) return;
      setPending(false);
      refresh();
      reportOutcome(owner, id, state.title, outcome, fn(onDispatched));
    });
  };

  const root = pickRootProps(rest, { aria: true });
  // The author's own name and description stand; the refusal reason joins them.
  const authorLabel = str(root["aria-label"]);
  const describedBy =
    [str(root["aria-describedby"]), blocked && reason ? reasonId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  const button = (
    <Button
      {...root}
      type="button"
      variant={
        compact
          ? (oneOf(variant, ["ghost", "outline", "subtle", "ghost-danger"] as const) ?? "ghost")
          : oneOf(variant, BUTTON_VARIANTS)
      }
      size={
        compact
          ? ICON_BUTTON_SIZE[oneOf(size, ["default", "sm", "xs"] as const) ?? "sm"]
          : oneOf(size, ["default", "sm", "xs", "lg"] as const)
      }
      loading={pending}
      aria-label={authorLabel ?? (compact ? textLabel : undefined)}
      aria-disabled={blocked || undefined}
      aria-describedby={describedBy}
      aria-keyshortcuts={state.combo ? comboToAriaKeyshortcuts(state.combo, isMac()) : undefined}
      data-action-id={id}
      onPointerEnter={refresh}
      onFocus={refresh}
      onClick={(event) => {
        if (blocked) {
          event.preventDefault();
          return;
        }
        onClick();
      }}
      className={cn(blocked && ARIA_DISABLED_CLASSES, str(className))}
    >
      {glyph}
      {compact ? null : label}
    </Button>
  );

  const showLabel = compact || state.combo !== undefined;
  const tip: ReactNode =
    blocked && reason ? (
      compact ? (
        <span className="flex flex-col gap-0.5">
          <span>{textLabel}</span>
          <span className="text-text-secondary">{reason}</span>
        </span>
      ) : (
        reason
      )
    ) : showLabel ? (
      <LabelWithKeys label={compact ? textLabel : label} combo={state.combo} />
    ) : null;

  return (
    <>
      {tip === null ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side={oneOf(tooltipSide, SIDES) ?? "bottom"} className={overlayZ}>
            <PluginStyleScope>{tip}</PluginStyleScope>
          </TooltipContent>
        </Tooltip>
      )}
      {blocked && reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
  );
}

/** What a menu draws for an `action` entry, or `null` when it draws nothing. */
export interface KitActionMenuRowModel {
  label: string;
  description: string | undefined;
  disabled: boolean;
  destructive: boolean;
  icon: unknown;
  shortcut: string | undefined;
  onSelect: () => void;
}

/**
 * Whether an `action` entry draws a row at all, read without hooks so a
 * menu can leave out a submenu whose rows would all be empty.
 */
export function actionMenuRowVisible(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const id = nonEmpty(field(entry, "actionId"));
  if (!id) return false;
  const state = readActionState(id, field(entry, "args"));
  if (nonEmpty(field(entry, "label")) === undefined && !state.title) return false;
  return state.runnable || field(entry, "whenUnavailable") !== "hide";
}

/**
 * The live model of an `action` menu entry. A menu's rows mount when it
 * opens, so each opening reads the action afresh. A row the action refuses
 * carries the reason as its second line, since a disabled row takes no
 * tooltip.
 */
export function useActionMenuRow(entry: PluginActionMenuItem): KitActionMenuRowModel | null {
  const owner = usePluginKitOwner();
  const id = nonEmpty(field(entry, "actionId"));
  const args = field(entry, "args");
  const combo = useEffectiveCombo(id);
  if (!id) return null;
  const state = readActionState(id, args);
  const label = nonEmpty(field(entry, "label")) ?? (state.title || undefined);
  if (label === undefined) return null;
  if (!state.runnable && field(entry, "whenUnavailable") === "hide") return null;
  const onDispatched = fn(entry.onDispatched);
  return {
    label,
    description: state.runnable ? nonEmpty(field(entry, "description")) : state.reason,
    disabled: !state.runnable,
    destructive: field(entry, "destructive") === true,
    icon: field(entry, "icon"),
    shortcut: combo,
    onSelect: () => {
      void dispatchActionFromView(id, args).then((outcome) =>
        reportOutcome(owner, id, state.title, outcome, onDispatched)
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Agents

const MARK_PX = { xs: 12, sm: 16, md: 20, lg: 24 } as const;

/**
 * The corner pip's hue, by the host's own attention policy: only the states
 * that want a human (waiting, and directing — the user's own unsent prompt)
 * earn one, so a pip on a toolbar of busy agents always means "look here".
 */
function pipTone(state: PluginAgentState | undefined): string | null {
  return state ? agentStateDotColor(state) : null;
}

const PIP_CUTOUT_CLASS =
  "ring-1 ring-surface-panel forced-colors:outline forced-colors:outline-1 forced-colors:outline-[Canvas]";

/** "Claude", or the id itself for an agent this Daintree does not know. */
export function agentName(agentId: string): string {
  return getAgentConfig(agentId)?.name ?? agentId;
}

/** The agent's mark at `px`, in its brand ink; the terminal glyph for one the registry lacks. */
function AgentMark({ agentId, px }: { agentId: string; px: number }) {
  const config = getAgentConfig(agentId);
  if (!config) {
    const Fallback = DEFAULT_PANEL_ICON;
    return (
      <Fallback
        className="shrink-0 text-text-secondary"
        style={{ width: px, height: px }}
        aria-hidden="true"
      />
    );
  }
  const Icon = config.icon;
  return (
    <BrandMark brandColor={config.color}>
      <Icon size={px} className="shrink-0" />
    </BrandMark>
  );
}

function StatePip({ state }: { state: PluginAgentState | undefined }) {
  const tone = pipTone(state);
  if (!tone) return null;
  return (
    <span
      aria-hidden="true"
      data-agent-pip={state}
      className={cn(
        "pointer-events-none absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full forced-colors:bg-[CanvasText]",
        PIP_CUTOUT_CLASS,
        tone
      )}
    />
  );
}

function KitAgentAvatar({
  agentId,
  size,
  state,
  label,
  decorative,
  className,
  ...rest
}: PluginAgentAvatarProps) {
  const id = nonEmpty(agentId);
  if (!id) return null;
  const px = MARK_PX[oneOf(size, ["xs", "sm", "md", "lg"] as const) ?? "sm"];
  const observed = oneOf(state, AGENT_STATES);
  const name =
    decorative === true
      ? undefined
      : (nonEmpty(label) ??
        (pipTone(observed)
          ? `${agentName(id)}, ${OBSERVATION[observed].bare.toLowerCase()}`
          : agentName(id)));
  return (
    <span
      {...pickRootProps(rest)}
      data-agent-id={id}
      className={cn("relative inline-flex shrink-0", str(className))}
      {...(name ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
    >
      <AgentMark agentId={id} px={px} />
      <StatePip state={observed} />
    </span>
  );
}

function KitAgentBadge({ agentId, label, size, state, className, ...rest }: PluginAgentBadgeProps) {
  const id = nonEmpty(agentId);
  if (!id) return null;
  const medium = size === "md";
  const observed = oneOf(state, AGENT_STATES);
  return (
    <span
      {...pickRootProps(rest)}
      data-agent-id={id}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 text-text-primary",
        medium ? "text-sm" : "text-xs",
        str(className)
      )}
    >
      <span className="relative inline-flex shrink-0" aria-hidden="true">
        <AgentMark agentId={id} px={medium ? 16 : 14} />
        <StatePip state={observed} />
      </span>
      <span className="min-w-0 truncate">{nonEmpty(label) ?? agentName(id)}</span>
      {observed && pipTone(observed) ? (
        <span className="sr-only">, {OBSERVATION[observed].bare.toLowerCase()}</span>
      ) : null}
    </span>
  );
}

/**
 * What Daintree saw, per state: the wording with no time, and with the time
 * the state was observed. Each says what the output looked like, never what
 * the agent is doing or has done ("Output stopped", not "Done").
 */
const OBSERVATION: Record<
  PluginAgentState,
  { bare: string; timed: (duration: string, ago: string) => string; duration: boolean }
> = {
  working: { bare: "Output active", timed: (d) => `Output active for ${d}`, duration: true },
  waiting: { bare: "Prompt on screen", timed: (d) => `Prompt on screen for ${d}`, duration: true },
  directing: { bare: "Unsent draft", timed: (d) => `Unsent draft for ${d}`, duration: true },
  idle: { bare: "No recent output", timed: (_d, ago) => `Output stopped ${ago}`, duration: false },
  completed: {
    bare: "Output stopped",
    timed: (_d, ago) => `Output stopped ${ago}`,
    duration: false,
  },
  exited: { bare: "Process exited", timed: (_d, ago) => `Exited ${ago}`, duration: false },
};

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** The observation for `state`, timed when `since` is a real moment, kept current. */
function useObservationLabel(state: PluginAgentState, since: number | undefined): string {
  const valid = since !== undefined && Number.isFinite(since);
  const now = useNow({ intervalMs: valid ? timeAgoTick(Date.now() - since, false) : HOUR_MS });
  const wording = OBSERVATION[state];
  if (!valid) return wording.bare;
  const age = Math.max(0, now - since);
  // A duration under a minute changes faster than the clock this reads, and
  // "for 0s" says nothing; the bare wording stands until a minute has passed.
  if (wording.duration && age < MINUTE_MS) return wording.bare;
  return wording.timed(formatElapsedDuration(age), formatTimeAgo(since, now));
}

/** The app's glyph for an agent state, in its hue; the working spinner turns. */
function AgentStateGlyph({ state, px }: { state: PluginAgentState; px: number }) {
  const Glyph = STATE_ICONS[state];
  return (
    <Glyph
      className={cn(
        "shrink-0",
        STATE_COLORS[state],
        state === "working" && "animate-spin-slow motion-reduce:animate-none"
      )}
      style={{ width: px, height: px }}
    />
  );
}

function KitAgentStateIndicator({
  state,
  since,
  variant,
  size,
  label,
  className,
  ...rest
}: PluginAgentStateIndicatorProps) {
  const observed = oneOf(state, AGENT_STATES) ?? "idle";
  const at = typeof since === "number" ? since : undefined;
  const wording = useObservationLabel(observed, at);
  const text = nonEmpty(label) ?? wording;
  const medium = size === "md";
  const glyph = <AgentStateGlyph state={observed} px={medium ? 14 : 12} />;
  if (variant === "glyph") {
    return (
      <span
        {...pickRootProps(rest)}
        data-agent-state={observed}
        role="img"
        aria-label={text}
        title={text}
        className={cn("inline-flex shrink-0", str(className))}
      >
        {glyph}
      </span>
    );
  }
  return (
    <span
      {...pickRootProps(rest)}
      data-agent-state={observed}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-text-secondary",
        medium ? "text-sm" : "text-xs",
        str(className)
      )}
    >
      <span aria-hidden="true" className="inline-flex shrink-0">
        {glyph}
      </span>
      <span className="min-w-0 truncate tabular-nums">{text}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// AgentPicker

const REFUSAL_REASONS = Object.keys(ROW_REFUSAL_LABEL).filter(
  (reason): reason is PluginSendToAgentRefusalReason => Object.hasOwn(ROW_REFUSAL_LABEL, reason)
);

/** The panes a plugin passed, narrowed to what `host.agents.list()` would have resolved. */
function readPanes(value: unknown): PluginAgentPane[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const panes: PluginAgentPane[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const terminalId = nonEmpty(field(item, "terminalId"));
    const agentId = nonEmpty(field(item, "agentId"));
    if (!terminalId || !agentId || seen.has(terminalId)) continue;
    seen.add(terminalId);
    const rawWorktree = field(item, "worktree");
    let worktree: PluginAgentPane["worktree"] = null;
    if (typeof rawWorktree === "object" && rawWorktree !== null) {
      const id = nonEmpty(field(rawWorktree, "id"));
      const name = nonEmpty(field(rawWorktree, "name"));
      if (id && name) worktree = { id, name, branch: nonEmpty(field(rawWorktree, "branch")) };
    }
    const canDraft = field(item, "canDraft") !== false;
    panes.push({
      terminalId,
      agentId,
      title: nonEmpty(field(item, "title")) ?? agentName(agentId),
      worktree,
      observedState: oneOf(field(item, "observedState"), AGENT_STATES),
      isFocused: field(item, "isFocused") === true,
      canDraft,
      draftRefusal: canDraft
        ? undefined
        : (oneOf(field(item, "draftRefusal"), REFUSAL_REASONS) ?? "not-agent"),
    });
  }
  return panes;
}

type PickerRow =
  | { kind: "agent"; id: string; pane: PluginAgentPane }
  | { kind: "launch"; id: string; agentId: string };

/** The picker badge's wording, as the host's own Send to agent picker draws it. */
function observedBadgeText(state: PluginAgentState | undefined): string | undefined {
  if (state === "waiting") return "Last seen waiting";
  if (state === "working") return "Last seen working";
  return undefined;
}

function ObservedBadge({ state }: { state: PluginAgentState | undefined }) {
  const text = observedBadgeText(state);
  if (text === undefined) return null;
  const waiting = state === "waiting";
  return (
    <Badge
      size="xs"
      tone="outline"
      className={cn("shrink-0", waiting ? "text-state-waiting" : "text-text-secondary")}
      data-state={state}
    >
      {text}
    </Badge>
  );
}

function headingAt(rows: readonly PickerRow[], index: number, spans: boolean): string | null {
  const row = rows[index];
  if (!spans || row?.kind !== "agent") return null;
  const previous = index > 0 ? rows[index - 1] : undefined;
  const worktreeId = row.pane.worktree?.id ?? null;
  if (previous?.kind === "agent" && (previous.pane.worktree?.id ?? null) === worktreeId)
    return null;
  return row.pane.worktree?.name ?? "No worktree";
}

const selectable = (row: PickerRow | undefined) =>
  row !== undefined && (row.kind === "launch" || row.pane.canDraft);

function KitAgentPicker(props: PluginAgentPickerProps) {
  const {
    agents,
    onSelect,
    launchAgents,
    worktreeId,
    trigger,
    open,
    defaultOpen,
    onOpenChange,
    "aria-label": ariaLabel,
    searchPlaceholder,
    emptyMessage,
    side,
    align,
  } = props;
  const owner = useKitOwnerAttributes();
  const overlayZ = useKitOverlayZClass();
  const listId = useId();
  const controlled = typeof open === "boolean";
  const [ownOpen, setOwnOpen] = useState(defaultOpen === true);
  const isOpen = controlled ? open : ownOpen;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const changeOpen = (next: boolean) => {
    if (!controlled) setOwnOpen(next);
    if (!next) {
      setQuery("");
      setCursor(null);
    }
    fn(onOpenChange)?.(next);
  };

  const panes = readPanes(agents);
  const preferred = nonEmpty(worktreeId);
  const agentRows: PickerRow[] = buildSendToAgentRows({
    panes,
    requestedWorktreeId: preferred,
    activeWorktreeId: null,
    worktreeNames: new Map(),
    agent: null,
  }).flatMap((row) => (row.kind === "agent" ? [row] : []));
  const matched: PickerRow[] = query.trim()
    ? filterSendToAgentRows(
        agentRows.flatMap((row) => (row.kind === "agent" ? [row] : [])),
        query
      ).flatMap((row) => (row.kind === "agent" ? [row] : []))
    : agentRows;
  const launchIds = Array.isArray(launchAgents)
    ? [...new Set(launchAgents.filter((id): id is string => typeof id === "string" && id !== ""))]
    : [];
  // "None of these, start one" is what a query matching nothing asks, so the
  // launch rows stay whatever is typed, as the host picker's creation rows do.
  const rows: PickerRow[] = [
    ...matched,
    ...launchIds.map((agentId) => ({ kind: "launch" as const, id: `launch:${agentId}`, agentId })),
  ];
  const spans =
    new Set(matched.map((row) => (row.kind === "agent" ? (row.pane.worktree?.id ?? "") : "")))
      .size > 1;
  const launchWorktree =
    (preferred ? panes.find((pane) => pane.worktree?.id === preferred)?.worktree : undefined) ??
    null;

  const firstSelectable = rows.findIndex(selectable);
  const cursorIndex = cursor === null ? -1 : rows.findIndex((row) => row.id === cursor);
  const active = cursorIndex >= 0 && selectable(rows[cursorIndex]) ? cursorIndex : firstSelectable;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const choose = (row: PickerRow | undefined) => {
    if (!row || !selectable(row)) return;
    const choice: PluginAgentPickerChoice =
      row.kind === "agent"
        ? {
            kind: "agent",
            terminalId: row.pane.terminalId,
            agentId: row.pane.agentId,
            worktreeId: row.pane.worktree?.id ?? null,
          }
        : {
            kind: "launch",
            agentId: row.agentId,
            worktreeId: launchWorktree?.id ?? preferred ?? null,
          };
    changeOpen(false);
    fn(onSelect)?.(choice);
  };

  const move = (from: number, step: 1 | -1) => {
    for (let i = from + step; i >= 0 && i < rows.length; i += step) {
      if (selectable(rows[i])) {
        setCursor(rows[i]!.id);
        document.getElementById(optionId(i))?.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys that confirm an IME candidate belong to the composition, not the list.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(active, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(active, -1);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      move(-1, 1);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      move(rows.length, -1);
    } else if (event.key === "Enter") {
      // The popover portals out of any form, but its React events still reach
      // the view's ancestors: an Enter that picks is spent here.
      event.preventDefault();
      event.stopPropagation();
      choose(rows[active]);
    }
  };

  const label = nonEmpty(ariaLabel) ?? "Choose an agent";
  const opener = isValidElement(trigger) ? (
    trigger
  ) : (
    <Button variant="secondary" size="sm" className="group">
      Choose agent…
      <ChevronDown
        data-animated-chevron
        className="h-3.5 w-3.5 text-text-secondary transition-transform duration-150 ease-out group-data-[state=open]:rotate-180"
        aria-hidden="true"
      />
    </Button>
  );

  return (
    <Popover open={isOpen} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>{opener}</PopoverTrigger>
      <PopoverContent
        {...owner}
        side={oneOf(side, SIDES) ?? "bottom"}
        align={oneOf(align, ALIGNS) ?? "start"}
        sideOffset={4}
        aria-label={label}
        // As wide as the host's agent rows need for a task title and its badge,
        // and never taller than the room the popover has.
        className={cn(
          "flex w-96 max-w-[calc(100vw-2rem)] flex-col p-0",
          "max-h-[min(28rem,var(--radix-popover-content-available-height))]",
          overlayZ
        )}
      >
        <PopoverSearchField
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(null);
          }}
          onClear={() => setQuery("")}
          onKeyDown={onKeyDown}
          placeholder={nonEmpty(searchPlaceholder) ?? "Search agents and worktrees"}
          role="combobox"
          aria-label={`Search ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
          aria-expanded={isOpen}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        />
        <ScrollShadow
          id={listId}
          role="listbox"
          aria-label={label}
          compact
          className="flex-1"
          // The fades are 16px deep; padding the scroll edge by as much keeps
          // an active row brought into view clear of them.
          scrollClassName="scroll-py-4 p-1"
        >
          {rows.map((row, index) => {
            const heading = headingAt(rows, index, spans);
            const enabled = selectable(row);
            const firstLaunch =
              row.kind === "launch" && index > 0 && rows[index - 1]?.kind === "agent";
            const title = row.kind === "agent" ? row.pane.title : `New ${agentName(row.agentId)}`;
            const detail =
              row.kind === "agent"
                ? row.pane.canDraft
                  ? agentName(row.pane.agentId)
                  : ROW_REFUSAL_LABEL[row.pane.draftRefusal ?? "not-agent"]
                : launchWorktree
                  ? `Starts in ${launchWorktree.name}`
                  : "Starts a new session";
            return (
              <div key={row.id}>
                {heading !== null ? (
                  <div
                    aria-hidden="true"
                    // The host picker's worktree heading: names keep their own case.
                    className="px-3 pb-1 pt-2 text-xs font-medium text-text-secondary"
                  >
                    {heading}
                  </div>
                ) : null}
                {firstLaunch ? (
                  <div aria-hidden="true" className="mx-3 my-1 border-t border-border-subtle" />
                ) : null}
                <div
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active && enabled}
                  aria-disabled={enabled ? undefined : true}
                  // The worktree heading is drawn once per run but named on every
                  // row, and the observed state the badge shows is spoken too.
                  aria-label={[
                    row.kind === "agent" && spans
                      ? (row.pane.worktree?.name ?? "No worktree")
                      : undefined,
                    title,
                    detail,
                    row.kind === "agent" && row.pane.canDraft
                      ? observedBadgeText(row.pane.observedState)
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  data-terminal-id={row.kind === "agent" ? row.pane.terminalId : undefined}
                  // Move, not enter: a list opening under a resting pointer must
                  // not light the row beneath it before the pointer moves.
                  onPointerMove={enabled && index !== active ? () => setCursor(row.id) : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(row)}
                  className={cn(
                    PALETTE_ROW_CLASS,
                    "group flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left text-text-secondary",
                    enabled ? "cursor-pointer" : "cursor-not-allowed"
                  )}
                >
                  <span className="relative inline-flex shrink-0" aria-hidden="true">
                    <AgentMark
                      agentId={row.kind === "agent" ? row.pane.agentId : row.agentId}
                      px={16}
                    />
                  </span>
                  <span className="min-w-0 flex-1 overflow-hidden">
                    {/* Unavailable steps the label down the ramp rather than
                        fading the row, which would take its reason down too. */}
                    <span
                      className={cn(
                        "block truncate text-sm font-medium",
                        enabled ? "text-text-primary" : "text-text-secondary"
                      )}
                    >
                      {title}
                    </span>
                    <span className="block truncate text-xs text-text-secondary">{detail}</span>
                  </span>
                  {row.kind === "agent" && row.pane.canDraft ? (
                    <ObservedBadge state={row.pane.observedState} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </ScrollShadow>
        {rows.length === 0 ? (
          <div role="status" className="px-3 pb-3 text-xs text-text-secondary">
            <PluginStyleScope>
              {content(emptyMessage) ??
                (query.trim() ? "No agents match" : "No agents in this project")}
            </PluginStyleScope>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Handing work to an agent

const SEND_LABEL = "Send to agent…";

// The refusals `host.sendToAgent` reports to the plugin alone; every other one
// the user already saw at their agent.
const PLUGIN_ONLY_REFUSAL: Record<string, string> = {
  "project-unavailable": "This project has no open window to send to",
  "prompt-open": "Another picker from this plugin is already open",
  busy: "Too many sends are in flight; try again in a moment",
};

function readOutcome(value: unknown): PluginSendToAgentOutcome {
  if (typeof value === "object" && value !== null) {
    const status = field(value, "status");
    if (status === "drafted") {
      return { status, terminalId: str(field(value, "terminalId")) ?? "" };
    }
    if (status === "refused") {
      const worktreeId = nonEmpty(field(value, "worktreeId"));
      return {
        status,
        reason: str(field(value, "reason")) ?? "unknown",
        ...(worktreeId ? { worktreeId } : {}),
      };
    }
  }
  return { status: "cancelled" };
}

/** Longest id the host takes for a worktree or terminal. */
const SEND_ID_MAX = 512;
const NO_TEXT_REASON = "Nothing to send yet";
const NO_PLUGIN_REASON = "Only works inside a plugin view";

function sendId(value: unknown): string | undefined {
  const id = nonEmpty(value);
  return id !== undefined && id.length <= SEND_ID_MAX ? id : undefined;
}

function KitSendToAgentButton(props: PluginSendToAgentButtonProps) {
  const {
    text,
    title,
    worktreeId,
    terminalId,
    channel,
    send,
    onResult,
    onError,
    children,
    variant,
    size,
    iconOnly,
    disabled,
    disabledReason,
    className,
    ...rest
  } = props;
  const owner = usePluginKitOwner();
  const overlayZ = useKitOverlayZClass();
  const reasonId = useId();
  const mounted = useMounted();
  const [pending, setPending] = useState(false);
  // Checked as the host checks it, so text it would refuse (blank once
  // controls are stripped, or over the limit) leaves the button unavailable
  // rather than failing at the worker; a title it would refuse is dropped.
  const body =
    typeof text === "string" && validateAgentContextPayload({ v: 1, text }) !== null
      ? text
      : undefined;
  const heading =
    typeof title === "string" && validateAgentContextPayload({ v: 1, text: "x", title }) !== null
      ? nonEmpty(title.trim())
      : undefined;
  const sendFn = fn(send);
  const reason =
    disabled === true
      ? (nonEmpty(disabledReason) ?? undefined)
      : body === undefined
        ? NO_TEXT_REASON
        : sendFn === undefined && owner === null
          ? NO_PLUGIN_REASON
          : undefined;
  const blocked = disabled === true || reason !== undefined;
  const label = content(children) ?? SEND_LABEL;
  const textLabel = typeof label === "string" ? label : SEND_LABEL;

  const run = async () => {
    if (body === undefined) return;
    const target = sendId(terminalId);
    const worktree = sendId(worktreeId);
    const request: PluginSendToAgentRequest = {
      text: body,
      ...(heading ? { title: heading } : {}),
      ...(worktree ? { worktreeId: worktree } : {}),
      ...(target ? { terminalId: target } : {}),
    };
    let outcome: PluginSendToAgentOutcome;
    try {
      const raw = sendFn
        ? await sendFn(request)
        : await window.electron.plugin.invoke(
            owner ?? "",
            nonEmpty(channel) ?? "sendToAgent",
            request
          );
      outcome = readOutcome(raw);
    } catch (error) {
      if (!mounted.current) return;
      const handle = fn(onError);
      if (handle) callPlugin(handle, error);
      else
        showPluginViewToast(owner, {
          tone: "error",
          message: `Couldn't send to an agent: ${formatErrorMessage(error, "the send failed")}`,
        });
      return;
    }
    if (!mounted.current) return;
    const report = fn(onResult);
    if (report) {
      callPlugin(report, outcome);
    } else if (outcome.status === "refused" && Object.hasOwn(PLUGIN_ONLY_REFUSAL, outcome.reason)) {
      showPluginViewToast(owner, {
        tone: "warning",
        message: PLUGIN_ONLY_REFUSAL[outcome.reason],
      });
    }
  };

  const compact = iconOnly === true;
  const root = pickRootProps(rest, { aria: true });
  const authorLabel = str(root["aria-label"]);
  const describedBy =
    [str(root["aria-describedby"]), blocked && reason ? reasonId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  const button = (
    <Button
      {...root}
      type="button"
      variant={
        compact
          ? (oneOf(variant, ["ghost", "outline", "subtle"] as const) ?? "ghost")
          : (oneOf(variant, BUTTON_VARIANTS) ?? "secondary")
      }
      size={
        compact
          ? ICON_BUTTON_SIZE[oneOf(size, ["default", "sm", "xs"] as const) ?? "sm"]
          : oneOf(size, ["default", "sm", "xs", "lg"] as const)
      }
      loading={pending}
      aria-label={authorLabel ?? (compact ? textLabel : undefined)}
      aria-disabled={blocked || undefined}
      aria-describedby={describedBy}
      onClick={(event) => {
        if (blocked || pending) {
          event.preventDefault();
          return;
        }
        setPending(true);
        void run()
          .catch((error: unknown) => logError("[plugin-ui] send to agent failed", error))
          .finally(() => {
            if (mounted.current) setPending(false);
          });
      }}
      className={cn(blocked && ARIA_DISABLED_CLASSES, str(className))}
    >
      <Send aria-hidden="true" />
      {compact ? null : label}
    </Button>
  );
  const tip: ReactNode =
    blocked && reason ? (
      compact ? (
        <span className="flex flex-col gap-0.5">
          <span>{textLabel}</span>
          <span className="text-text-secondary">{reason}</span>
        </span>
      ) : (
        reason
      )
    ) : compact ? (
      textLabel
    ) : null;
  return (
    <>
      {tip === null ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="bottom" className={overlayZ}>
            {tip}
          </TooltipContent>
        </Tooltip>
      )}
      {blocked && reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
  );
}

const DRAG_LABEL = "Drag to an agent";

function KitContextDragSource({
  text,
  title,
  sourceLabel,
  children,
  label,
  disabled,
  onDragStart,
  className,
  ...rest
}: PluginContextDragSourceProps) {
  const payload = validateAgentContextPayload({
    v: 1,
    text,
    ...(title !== undefined ? { title } : {}),
    ...(sourceLabel !== undefined ? { source: { label: sourceLabel } } : {}),
  });
  const live = payload !== null && disabled !== true;
  const started = fn(onDragStart);
  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    // A kit drag around this never starts from it, and nothing else in the
    // view should see a system drag it did not begin.
    event.stopPropagation();
    if (!payload || !live) {
      event.preventDefault();
      return;
    }
    setAgentContextDragData(event.dataTransfer, payload);
    started?.();
  };
  const custom = content(children);
  const shared = {
    ...pickRootProps(rest),
    // Always marked draggable, live or not: kit drags skip `[draggable='true']`,
    // so a press on an unavailable source never lifts the card around it. Its
    // dragstart is cancelled instead.
    draggable: true,
    "data-agent-context-source": "",
    "aria-disabled": live ? undefined : true,
    onDragStart: handleDragStart,
  };
  if (custom !== undefined) {
    return (
      <div {...shared} className={cn(live && "cursor-grab active:cursor-grabbing", str(className))}>
        {custom}
      </div>
    );
  }
  const chipLabel = nonEmpty(label) ?? DRAG_LABEL;
  return (
    <span
      {...shared}
      title={live ? `${chipLabel}: drop it on an agent's terminal or input bar` : undefined}
      className={cn(
        "inline-flex select-none items-center gap-0.5 rounded-[var(--radius-md)] border border-border-subtle bg-overlay-subtle py-0 pl-1.5 pr-2 text-xs text-text-secondary transition-colors duration-150 ease-out",
        live
          ? "cursor-grab hover:border-border-default hover:text-text-primary active:cursor-grabbing"
          : "opacity-50",
        str(className)
      )}
    >
      {/* The app's one drag grip; the chip itself is the drag source, so the
          box takes no focus of its own. */}
      <span aria-hidden="true" className={cn(DRAG_GRIP_CLASS, "-my-px -ml-1.5")}>
        <GripVertical className={DRAG_GRIP_ICON_CLASS} />
      </span>
      {chipLabel}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TerminalSnapshot

const SNAPSHOT_ROWS_MAX = 200;
const SNAPSHOT_FONT_PX = { xs: 10, sm: 12 } as const;

// Every escape sequence: the string ones (OSC titles and links, DCS, SOS, PM,
// APC) up to BEL, ST, the next ESC or the end, across lines; CSI, complete or
// cut off; and the two-byte escapes. Only a plain SGR (colour and weight) is
// kept. A snapshot draws text and colour; cursor moves and screen clears mean
// nothing in a still.
/* eslint-disable no-control-regex -- terminal escapes and controls are the input */
const ESCAPES =
  /\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\|(?=\x1b)|$)|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[ -/]*[0-~]?/g;
const PLAIN_SGR = /^\x1b\[[0-9;:]*m$/;
const SGR = /\x1b\[[0-9;:]*m/g;
const STRAY_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

/** `text` with every escape but a plain SGR removed. */
function keepSgrOnly(text: string): string {
  return text.replace(ESCAPES, (sequence) => (PLAIN_SGR.test(sequence) ? sequence : ""));
}

const ANSI_TOKEN: Record<string, string> = {
  black: "terminal-black",
  red: "terminal-red",
  green: "terminal-green",
  yellow: "terminal-yellow",
  blue: "terminal-blue",
  magenta: "terminal-magenta",
  cyan: "terminal-cyan",
  white: "terminal-white",
};

const XTERM_CUBE = [0, 95, 135, 175, 215, 255];

/** An xterm palette index past the sixteen theme colours, as `rgb()`. */
function paletteRgb(index: number): string | undefined {
  if (index >= 16 && index <= 231) {
    const n = index - 16;
    return `rgb(${XTERM_CUBE[Math.floor(n / 36)]}, ${XTERM_CUBE[Math.floor(n / 6) % 6]}, ${XTERM_CUBE[n % 6]})`;
  }
  if (index >= 232 && index <= 255) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  return undefined;
}

const PALETTE_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** Anser's colour class (`ansi-bright-red`, `ansi-palette-45`) as a CSS colour. */
function ansiColor(name: string | null, truecolor: string | null): string | undefined {
  if (!name) return undefined;
  if (name === "ansi-truecolor") {
    return truecolor && /^\d{1,3}, \d{1,3}, \d{1,3}$/.test(truecolor)
      ? `rgb(${truecolor})`
      : undefined;
  }
  const palette = /^ansi-palette-(\d{1,3})$/.exec(name);
  if (palette) {
    const index = Number(palette[1]);
    if (index < 16) {
      const base = PALETTE_NAMES[index % 8]!;
      return `var(--theme-${index >= 8 ? "terminal-bright-" + base : ANSI_TOKEN[base]})`;
    }
    return paletteRgb(index);
  }
  const named = /^ansi-(bright-)?([a-z]+)$/.exec(name);
  if (!named || !Object.hasOwn(ANSI_TOKEN, named[2]!)) return undefined;
  return `var(--theme-${named[1] ? `terminal-bright-${named[2]}` : ANSI_TOKEN[named[2]!]})`;
}

interface SnapshotSpan {
  text: string;
  style: CSSProperties | undefined;
}

/**
 * Resolves one physical line's carriage returns: what was drawn last from the line's start is what shows, while the
 * colour changes in the overwritten part still carry on into what follows.
 */
function flattenLine(line: string): string {
  const parts = line.split("\r");
  const drawn = parts.pop() ?? "";
  const carried = parts.map((part) => part.match(SGR)?.join("") ?? "").join("");
  return carried + drawn;
}

function chunkStyle(chunk: Anser.AnserJsonEntry): CSSProperties | undefined {
  // Reverse video arrives resolved: Anser fills an unset side with black or
  // white and swaps the two before handing the chunk over, so it is drawn as is.
  const color = ansiColor(chunk.fg, chunk.fg_truecolor);
  const background = ansiColor(chunk.bg, chunk.bg_truecolor);
  const decorations = chunk.decorations ?? [];
  const style: CSSProperties = {};
  if (color) style.color = color;
  if (background) style.backgroundColor = background;
  if (decorations.includes("bold")) style.fontWeight = 600;
  if (decorations.includes("dim")) style.opacity = 0.6;
  if (decorations.includes("italic")) style.fontStyle = "italic";
  if (decorations.includes("underline")) style.textDecoration = "underline";
  if (decorations.includes("strikethrough")) style.textDecoration = "line-through";
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * The last `rows` lines of `text`, each as coloured spans. The text is parsed
 * as one stream, so a colour set on an earlier line, or above the lines kept,
 * still colours them.
 */
export function snapshotLines(text: string, rows: number): SnapshotSpan[][] {
  // Escapes go first, over the whole text, since a string sequence can run
  // across lines.
  const stream = keepSgrOnly(text).replace(/\r\n/g, "\n").split("\n").map(flattenLine).join("\n");
  const lines: SnapshotSpan[][] = [[]];
  for (const chunk of Anser.ansiToJson(stream, { use_classes: true, remove_empty: true })) {
    const style = chunkStyle(chunk);
    chunk.content.split("\n").forEach((piece, index) => {
      if (index > 0) lines.push([]);
      const clean = piece.replace(STRAY_CONTROLS, "");
      if (clean !== "") lines[lines.length - 1]!.push({ text: clean, style });
    });
  }
  while (lines.length > 0 && lines[lines.length - 1]!.every((span) => span.text.trim() === "")) {
    lines.pop();
  }
  return lines.slice(-rows);
}

function KitTerminalSnapshot({
  text,
  title,
  agentId,
  state,
  since,
  rows,
  scale,
  onClick,
  selected,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginTerminalSnapshotProps) {
  const lineCount =
    typeof rows === "number" && Number.isInteger(rows) && rows > 0
      ? Math.min(rows, SNAPSHOT_ROWS_MAX)
      : 12;
  const fontPx = SNAPSHOT_FONT_PX[oneOf(scale, ["xs", "sm"] as const) ?? "xs"];
  const lines = snapshotLines(str(text) ?? "", lineCount);
  const heading = nonEmpty(title);
  const agent = nonEmpty(agentId);
  const observed = oneOf(state, AGENT_STATES);
  const at = typeof since === "number" ? since : undefined;
  const observation = useObservationLabel(observed ?? "idle", at);
  const activate = fn(onClick);
  const name =
    nonEmpty(ariaLabel) ??
    [heading ?? (agent ? agentName(agent) : "Terminal"), observed ? observation : undefined]
      .filter(Boolean)
      .join(", ");

  const header =
    heading || agent || observed ? (
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface-panel px-2">
        {agent ? (
          <span className="relative inline-flex shrink-0" aria-hidden="true">
            <AgentMark agentId={agent} px={14} />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
          {heading ?? (agent ? agentName(agent) : "Terminal")}
        </span>
        {observed ? (
          <span className="inline-flex min-w-0 shrink items-center gap-1 text-2xs text-text-secondary">
            <AgentStateGlyph state={observed} px={10} />
            <span className="truncate">{observation}</span>
          </span>
        ) : null}
      </div>
    ) : null;

  const screen = (
    <div
      data-terminal-snapshot-body=""
      // Static: no caret, no selection handles, nothing that reads as input.
      className="relative min-h-0 flex-1 overflow-hidden bg-terminal-background px-2 py-1.5 text-terminal-foreground"
      style={{
        fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
        fontSize: fontPx,
        lineHeight: 1.3,
        minHeight: `${lineCount * 1.3 * fontPx + 12}px`,
      }}
    >
      {lines.map((spans, index) => (
        <div key={index} className="overflow-hidden whitespace-pre">
          {spans.length === 0
            ? " "
            : spans.map((span, spanIndex) => (
                <span key={spanIndex} style={span.style}>
                  {span.text}
                </span>
              ))}
        </div>
      ))}
      {/* Long lines are cut at the edge, not wrapped: the fade says the line
          goes on, and the terminal itself is one click away. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-terminal-background to-transparent"
      />
    </div>
  );

  const isSelected = selected === true;
  const frame = cn(
    "flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default text-left",
    // The host's selection mark: the one ink held to 3:1 against the surface,
    // never accent, since several previews sit side by side.
    isSelected && "outline outline-2 -outline-offset-1 outline-selection-outline",
    str(className)
  );
  const current = isSelected ? { "aria-current": true as const } : {};
  if (activate) {
    return (
      <button
        type="button"
        {...pickRootProps(rest)}
        {...current}
        aria-label={name}
        onClick={() => activate()}
        className={cn(
          frame,
          "cursor-pointer transition-colors duration-150 ease-out hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        )}
      >
        {header}
        {screen}
      </button>
    );
  }
  return (
    <figure {...pickRootProps(rest)} {...current} aria-label={name} className={cn(frame, "m-0")}>
      {header}
      {screen}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Keys

function KitShortcutHint({
  actionId,
  shortcut,
  label,
  variant,
  className,
  ...rest
}: PluginShortcutHintProps) {
  const id = nonEmpty(actionId);
  const bound = useEffectiveCombo(id);
  const combo = id ? bound : nonEmpty(shortcut);
  if (!combo) return null;
  // Read through the kit's own action read, so a restricted action's title stays hidden.
  const title =
    content(label) ?? (id ? readActionState(id, undefined).title || undefined : undefined);
  const card = variant !== "inline";
  return (
    <span
      {...pickRootProps(rest)}
      data-shortcut-hint=""
      className={cn(
        "inline-flex max-w-full items-center whitespace-nowrap text-xs",
        SHORTCUT_ROW_GAP,
        card
          ? cn(
              TOOLTIP_CARD_PADDING,
              "rounded-[var(--radius-md)] surface-overlay shadow-overlay text-text-primary"
            )
          : "text-text-secondary",
        str(className)
      )}
    >
      {title !== undefined ? <span className="min-w-0 truncate">{title}</span> : null}
      <KbdChord shortcut={combo} className="shrink-0" />
    </span>
  );
}

// Width-priority drop classes for the hints after the first, from the trailing
// edge: the last hint hides first. Static so Tailwind sees each variant.
const HINT_DROP_CLASSES = [
  "@max-[380px]/key-hints:hidden",
  "@max-[280px]/key-hints:hidden",
  "@max-[200px]/key-hints:hidden",
];

interface KeyHintModel {
  label: string;
  keys: string[] | undefined;
  shortcut: string | undefined;
}

/** `revision` only busts the React Compiler's cache when the bindings change. */
function readHints(value: unknown, revision: number): KeyHintModel[] {
  void revision;
  const combos = (actionId: string) => keybindingService.getEffectiveCombo(actionId) || undefined;
  if (!Array.isArray(value)) return [];
  const out: KeyHintModel[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const label = nonEmpty(field(item, "label"));
    if (!label) continue;
    const actionId = nonEmpty(field(item, "actionId"));
    const rawKeys = field(item, "keys");
    const keys = Array.isArray(rawKeys)
      ? rawKeys.filter((key): key is string => typeof key === "string" && key !== "")
      : [];
    const shortcut = actionId ? combos(actionId) : nonEmpty(field(item, "shortcut"));
    if (actionId && !shortcut) continue;
    if (!shortcut && keys.length === 0) continue;
    out.push({ label, keys: shortcut ? undefined : keys, shortcut });
  }
  return out;
}

// Spoken names for the glyph caps a literal `keys` hint draws, as KbdChord
// speaks its own: "↑↓" is read as "Up Down", never as the symbol names.
const KEY_GLYPH_NAMES: Record<string, string> = {
  "↑": "Up",
  "↓": "Down",
  "←": "Left",
  "→": "Right",
  "⏎": "Enter",
  "↵": "Enter",
  "⎋": "Escape",
  "⇥": "Tab",
  "⌫": "Delete",
  "⌘": "Command",
  "⇧": "Shift",
  "⌥": "Option",
  "⌃": "Control",
};

function spokenKey(key: string): string {
  return [...key]
    .map((glyph) => (Object.hasOwn(KEY_GLYPH_NAMES, glyph) ? KEY_GLYPH_NAMES[glyph] : glyph))
    .join(" ");
}

/** One hint as the host's palette footer draws it: full-size caps, then the label. */
function KeyHintChip({
  hint,
  className,
  truncate = false,
}: {
  hint: KeyHintModel;
  className?: string;
  /** The leading hint gives way with an ellipsis rather than widening the row. */
  truncate?: boolean;
}) {
  return (
    <span
      data-key-hint=""
      className={cn("inline-flex items-baseline", truncate ? "min-w-0" : "shrink-0", className)}
    >
      {hint.shortcut ? (
        <KbdChord shortcut={hint.shortcut} className="shrink-0" />
      ) : (
        <>
          <span className="sr-only">{hint.keys!.map(spokenKey).join(" ")}</span>
          {hint.keys!.map((key, index) => (
            // Sans, as KbdChord sets its glyph keys: the mono face has no arrows.
            <kbd
              key={index}
              aria-hidden="true"
              className={cn(
                KBD_CLASS,
                "shrink-0",
                index > 0 && "ml-1",
                /^[^\w]+$/.test(key) && "font-sans"
              )}
            >
              {key}
            </kbd>
          ))}
        </>
      )}
      <span className={cn("ml-1.5", truncate && "min-w-0 truncate")}>{hint.label}</span>
    </span>
  );
}

function KitKeyHints({
  hints,
  variant,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginKeyHintsProps) {
  // Any rebinding moves the revision, which redraws the row and re-reads it.
  const [revision] = useActionRevision();
  const models = readHints(hints, revision);
  if (models.length === 0) return null;
  const [first, ...others] = models;
  const footer = variant === "footer";
  return (
    <div
      {...pickRootProps(rest)}
      role="note"
      aria-label={nonEmpty(ariaLabel) ?? "Keyboard shortcuts"}
      className={cn(
        "@container/key-hints flex w-full min-w-0 items-center justify-between gap-3 text-xs text-text-secondary",
        footer && "border-t border-border-strong bg-surface-panel px-3 py-2",
        str(className)
      )}
    >
      <KeyHintChip hint={first!} truncate />
      {others.length > 0 ? (
        <span className="flex min-w-0 items-center gap-3">
          {others.map((hint, index) => {
            const fromEnd = others.length - 1 - index;
            return (
              <KeyHintChip
                key={`${index}-${hint.label}`}
                hint={hint}
                className={HINT_DROP_CLASSES[Math.min(fromEnd, HINT_DROP_CLASSES.length - 1)]}
              />
            );
          })}
        </span>
      ) : null}
    </div>
  );
}

export const pluginKitNativeAgents = {
  ActionButton: KitActionButton,
  AgentAvatar: KitAgentAvatar,
  AgentBadge: KitAgentBadge,
  AgentStateIndicator: KitAgentStateIndicator,
  AgentPicker: KitAgentPicker,
  SendToAgentButton: KitSendToAgentButton,
  ContextDragSource: KitContextDragSource,
  TerminalSnapshot: KitTerminalSnapshot,
  ShortcutHint: KitShortcutHint,
  KeyHints: KitKeyHints,
};
