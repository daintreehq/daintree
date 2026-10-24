// Daintree-native: actions, agents, terminals and keys. These components speak
// the host's own concepts and read only what a plugin view may already see:
// the action catalogue (`host.actions`, no capability), the agent CLI registry
// (static), and data the view's worker hands it (`host.agents.list()` under
// `agent:read`, `host.sendToAgent` under `agent:input`).

import type { ReactElement, ReactNode } from "react";
import type {
  PluginAlign,
  PluginAriaRootAttributes,
  PluginButtonVariant,
  PluginIconSource,
  PluginRootAttributes,
  PluginSide,
} from "./common.js";

/**
 * An agent state Daintree observed on a terminal, as `host.agents.list()`'s
 * `observedState` and `host.getAgentState()` report it. Read off the
 * terminal's output and often wrong: an observation, never a fact.
 */
export type PluginAgentState =
  "idle" | "working" | "waiting" | "directing" | "completed" | "exited";

/** What an action dispatch from a kit control came to. */
export interface PluginActionDispatchOutcome {
  ok: boolean;
  /** Set when `ok` is false: the host's `ActionErrorCode` and its message. */
  error?: { code: string; message: string };
}

/**
 * Props of `ActionButton`: a button that runs one of Daintree's actions, as
 * `host.dispatch` would. Its label, keyboard shortcut and availability come
 * from the action itself, so the button reads and behaves like the app's own.
 * An action plugins may not run (restricted, deny-listed, or one that asks
 * for confirmation) and one that is disabled right now draw disabled, with the
 * reason in the tooltip.
 */
export interface PluginActionButtonProps extends PluginAriaRootAttributes {
  /** The action's id, e.g. `"worktree.refresh"` or one your plugin registered. */
  actionId: string;
  /** Arguments for the action, checked against its schema at dispatch. */
  args?: unknown;
  /** The label. Defaults to the action's own title. */
  children?: ReactNode;
  /** A leading icon. Actions carry no icon of their own, so name the one you want. */
  icon?: PluginIconSource;
  /**
   * Draws an icon-only button named by the label, with the label and shortcut
   * as its tooltip. Needs `icon`.
   */
  iconOnly?: boolean;
  /** As `Button`. Icon-only buttons take `ghost` (the default), `outline`, `subtle` or `ghost-danger`. */
  variant?: PluginButtonVariant;
  /** As `Button`; icon-only, as `IconButton` (`sm` by default). */
  size?: "default" | "sm" | "xs" | "lg";
  /**
   * What an action that cannot run draws: `disable` (the default) keeps it in
   * place with the reason in its tooltip; `hide` draws nothing. An action this
   * Daintree does not know is always hidden unless you give it a label.
   */
  whenUnavailable?: "disable" | "hide";
  /** Disables it on your own terms, with `disabledReason` in the tooltip. */
  disabled?: boolean;
  disabledReason?: string;
  tooltipSide?: PluginSide;
  /** Called once the dispatch settles, with its outcome. */
  onDispatched?: (outcome: PluginActionDispatchOutcome) => void;
  className?: string;
}

/**
 * A menu row that runs one of Daintree's actions, for `DropdownMenu` and
 * `ContextMenu` `items`. Like `ActionButton`, it takes its label and shortcut
 * from the action and draws disabled when the action cannot run.
 */
export interface PluginActionMenuItem {
  type: "action";
  actionId: string;
  args?: unknown;
  /** The label. Defaults to the action's own title. */
  label?: string;
  icon?: PluginIconSource;
  /** A quiet second line under the label. */
  description?: string;
  /** Draws the row in the destructive tone. */
  destructive?: boolean;
  /** As `ActionButton`'s: `disable` (the default) or `hide`. */
  whenUnavailable?: "disable" | "hide";
  onDispatched?: (outcome: PluginActionDispatchOutcome) => void;
}

/** Sizes of an agent's mark: 12, 16 (the default), 20 and 24 px. */
export type PluginAgentAvatarSize = "xs" | "sm" | "md" | "lg";

/**
 * Props of `AgentAvatar`: an agent CLI's mark from Daintree's agent registry,
 * the one its tabs, toolbar and launchers draw, in the agent's brand ink.
 */
export interface PluginAgentAvatarProps extends PluginRootAttributes {
  /** The agent's id: `claude`, `codex`, `gemini`, … as `host.agents.list()` reports it. */
  agentId: string;
  size?: PluginAgentAvatarSize;
  /**
   * A pip on the mark's corner, by the host toolbar's attention rule: only
   * `waiting` and `directing` (the states that want a human) draw one, in the
   * hue of that state's glyph. Other states draw none.
   */
  state?: PluginAgentState;
  /** The accessible name. Defaults to the agent's name; `decorative` drops it. */
  label?: string;
  /** Hidden from assistive tech, for a mark beside the agent's name in text. */
  decorative?: boolean;
  className?: string;
}

/** Props of `AgentBadge`: an agent's mark and name, inline. */
export interface PluginAgentBadgeProps extends PluginRootAttributes {
  agentId: string;
  /** The name to show. Defaults to the agent's name from the registry. */
  label?: string;
  /** `sm` (12px text, the default) or `md` (14px). */
  size?: "sm" | "md";
  /** As `AgentAvatar`'s: a pip for a state that wants a human. */
  state?: PluginAgentState;
  className?: string;
}

/**
 * Props of `AgentStateIndicator`: what Daintree saw on an agent's terminal,
 * with the app's own state glyph, worded as an observation ("Output stopped
 * 2m ago"), never as a conclusion ("Done").
 */
export interface PluginAgentStateIndicatorProps extends PluginRootAttributes {
  state: PluginAgentState;
  /** When the state was observed, in epoch ms. Adds how long ago, kept current. */
  since?: number;
  /** `label` (the default) is the glyph and the wording; `glyph` the glyph alone, named. */
  variant?: "label" | "glyph";
  /** `sm` (12px, the default) or `md` (14px). */
  size?: "sm" | "md";
  /** Your own wording in place of the host's. Keep it an observation. */
  label?: string;
  className?: string;
}

/**
 * An agent pane `AgentPicker` lists: the shape `host.agents.list()` resolves,
 * so the worker's answer can be passed straight through.
 */
export interface PluginAgentPickerPane {
  terminalId: string;
  title: string;
  agentId: string;
  worktree: { id: string; name: string; branch?: string } | null;
  observedState?: PluginAgentState;
  isFocused?: boolean;
  /** `false` lists the pane disabled, with `draftRefusal` as the reason. */
  canDraft?: boolean;
  draftRefusal?: string;
}

/** What the user chose in an `AgentPicker`. */
export type PluginAgentPickerChoice =
  | { kind: "agent"; terminalId: string; agentId: string; worktreeId: string | null }
  | { kind: "launch"; agentId: string; worktreeId: string | null };

/**
 * Props of `AgentPicker`: a searchable list of the project's agent panes,
 * grouped by worktree, with each pane's last observed state, and optionally
 * rows to start an agent CLI. It picks; what happens next is yours, usually a
 * `host.sendToAgent(text, { terminalId })` through your worker.
 */
export interface PluginAgentPickerProps {
  /** The panes, as `host.agents.list()` resolves them. */
  agents: readonly PluginAgentPickerPane[];
  onSelect: (choice: PluginAgentPickerChoice) => void;
  /** Agent CLI ids offered as "New …" rows after the panes. */
  launchAgents?: readonly string[];
  /** The worktree this is about: its group comes first and its agent is preselected. */
  worktreeId?: string;
  /** The button that opens it. Defaults to a "Choose agent…" button. */
  trigger?: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Names the list ("Send to agent"). */
  "aria-label"?: string;
  searchPlaceholder?: string;
  /** Shown when there are no panes and nothing to start. */
  emptyMessage?: ReactNode;
  side?: PluginSide;
  align?: PluginAlign;
}

/**
 * What `host.sendToAgent` resolved, as your worker hands it back. Only
 * `project-unavailable`, `prompt-open` and `busy` refusals are yours to report.
 */
export type PluginSendToAgentOutcome =
  | { status: "drafted"; terminalId: string }
  | { status: "cancelled" }
  | { status: "refused"; reason: string; worktreeId?: string };

/** The request `SendToAgentButton` sends to your worker. */
export interface PluginSendToAgentRequest {
  text: string;
  title?: string;
  worktreeId?: string;
  terminalId?: string;
}

/**
 * Props of `SendToAgentButton`: the **Send to agent…** control. It asks your
 * worker, which alone may call `host.sendToAgent` (gated on `agent:input`),
 * over a channel: by default it invokes `"sendToAgent"` with a
 * {@link PluginSendToAgentRequest}, the handler the docs' recipe registers.
 * A refusal only your plugin hears about is shown as a toast from the view.
 */
export interface PluginSendToAgentButtonProps extends PluginAriaRootAttributes {
  /** The work to hand over. Blank text disables the button. */
  text: string;
  /** A heading above the text in the draft, at most 120 characters. */
  title?: string;
  /** Steers the host's picker; typically the view's `worktreeId` prop. */
  worktreeId?: string;
  /** Drafts straight into this pane, with no picker. */
  terminalId?: string;
  /** The worker channel to invoke. Defaults to `"sendToAgent"`. */
  channel?: string;
  /** Your own send in place of the channel; resolve with what `host.sendToAgent` resolved. */
  send?: (request: PluginSendToAgentRequest) => Promise<PluginSendToAgentOutcome>;
  /** Called with the outcome once the send settles. */
  onResult?: (outcome: PluginSendToAgentOutcome) => void;
  /** Called when the send throws. Without it the button shows the failure as a toast. */
  onError?: (error: unknown) => void;
  /** Defaults to "Send to agent…". */
  children?: ReactNode;
  variant?: PluginButtonVariant;
  size?: "default" | "sm" | "xs" | "lg";
  /** Draws an icon-only button with the label as its tooltip. */
  iconOnly?: boolean;
  /** Disables it on your own terms, with `disabledReason` in the tooltip and spoken. */
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}

/**
 * Props of `ContextDragSource`: makes its content draggable onto an agent
 * terminal, carrying the `daintree-context` payload (and the text as plain
 * text for a drop anywhere else). Coexists with kit drags: a kit drag never
 * starts from inside it. Without children it draws a "Drag to an agent" grip.
 *
 * Give `reference` instead of `text` to carry an item of one of the plugin's
 * context providers: the drop leaves the same chip as picking it from the
 * composer's `@` menu, and the agent gets its content as it reads at send.
 */
export interface PluginContextDragSourceProps extends PluginRootAttributes {
  /**
   * The text that lands in the agent's draft. Non-blank, at most 32,768
   * characters. Ignored when `reference` is given.
   */
  text?: string;
  /**
   * An item of one of this plugin's `contributes.contextProviders`: its
   * `prefix`, an `id` its `resolve` accepts, and the chip's `label` (at most
   * 120 characters).
   */
  reference?: { prefix: string; id: string; label?: string };
  /** A heading above it, at most 120 characters. */
  title?: string;
  /** Where it came from, beside the heading ("Kanban"), at most 80 characters. */
  sourceLabel?: string;
  /** What to make draggable. Omitted, the kit's grip chip with `label`. */
  children?: ReactNode;
  /** The chip's text. Defaults to "Drag to an agent". */
  label?: string;
  /** Stops it starting a drag. */
  disabled?: boolean;
  /** Called after a drag with a valid payload starts. */
  onDragStart?: () => void;
  className?: string;
}

/**
 * Props of `TerminalSnapshot`: a still, read-only preview of a terminal's
 * last lines, drawn in the terminal's own colours and face, under a title row
 * with the agent's mark and observed state. It takes no input.
 */
export interface PluginTerminalSnapshotProps extends PluginRootAttributes {
  /** The output, ANSI colour codes and all; only its last `rows` lines show. */
  text: string;
  title?: string;
  /** Draws the agent's mark before the title. */
  agentId?: string;
  state?: PluginAgentState;
  /** When `state` was observed, in epoch ms. */
  since?: number;
  /** Lines shown. Defaults to 12, at most 200. */
  rows?: number;
  /** The text size: `xs` (10px, the default) or `sm` (12px, the terminal's own). */
  scale?: "xs" | "sm";
  /** Makes the whole snapshot a button, e.g. to focus that terminal. */
  onClick?: () => void;
  /**
   * Marks it as the current one in a set of previews: the host's neutral
   * current-thumbnail ring, and `aria-current` for assistive tech.
   */
  selected?: boolean;
  /** Names it for assistive tech. Defaults to the title. */
  "aria-label"?: string;
  className?: string;
}

/**
 * Props of `ShortcutHint`: a label and its keys, drawn as Daintree's shortcut
 * hint card or as a plain row. Given `actionId`, it shows that action's title
 * and the user's current binding for it, and draws nothing while it has none.
 */
export interface PluginShortcutHintProps extends PluginRootAttributes {
  /** An action whose title and current binding to show. */
  actionId?: string;
  /** A combo in the app's notation (`"Cmd+K"`), when there is no `actionId`. */
  shortcut?: string;
  /** The label. Defaults to the action's title. */
  label?: ReactNode;
  /** `card` (the default) is the host's hint card; `inline` the row alone. */
  variant?: "card" | "inline";
  className?: string;
}

/** One hint in a `KeyHints` row: literal `keys`, a `shortcut` combo, or an action's binding. */
export interface PluginKeyHint {
  label: string;
  /** Literal key caps, e.g. `["↑↓"]`. */
  keys?: readonly string[];
  /** A combo in the app's notation (`"Cmd+K"`, `"Enter"`, `"Escape"`). */
  shortcut?: string;
  /** An action whose current binding to show; the hint drops out while it has none. */
  actionId?: string;
}

/**
 * Props of `KeyHints`: a row of key hints ("⏎ Open  ⌘K Search  Esc Close"),
 * drawn as Daintree's palette footers draw theirs. The first hint never
 * hides; the rest drop from the end as the row narrows.
 */
export interface PluginKeyHintsProps extends PluginRootAttributes {
  hints: readonly PluginKeyHint[];
  /** `inline` (the default) is the row alone; `footer` the footer band with its top edge. */
  variant?: "inline" | "footer";
  "aria-label"?: string;
  className?: string;
}
