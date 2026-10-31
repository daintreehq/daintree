// Hook contracts: the host channel and plugin events, selection, hotkeys,
// history, disclosure, debouncing, toasts and the theme tokens.

import type { MouseEvent } from "react";

/**
 * Return shape of the `useHostChannel(pluginId, channel)` hook. `invoke`
 * resolves with the validated channel result on success, or `undefined` if
 * the host rejected the call (the rejection is surfaced via `error`). Only
 * the latest `invoke()` updates `loading` / `error` — stale earlier calls are
 * dropped to keep concurrent invocations coherent. Changing `pluginId` or
 * `channel` also supersedes calls made against the previous target: they
 * resolve `undefined` and leave `loading`, `error` and `disconnected` alone.
 * A target change clears `loading` / `error` but keeps `disconnected`.
 */
export interface UseHostChannelResult<TArgs, TResult> {
  invoke: (args: TArgs) => Promise<TResult | undefined>;
  loading: boolean;
  error: Error | null;
  /**
   * The latest call failed because the link to the view's host is down
   * (`error` is a `HostDisconnectedError` or `OutcomeUnknownError`). Cleared by
   * the next call that gets through. Always `false` for a window on the
   * plugin's own machine.
   */
  disconnected: boolean;
}

/**
 * Handler signature for `usePluginEvent(pluginId, channel, handler)`. Receives
 * each payload pushed by the plugin's main-side `host.postToPanel(channel,
 * payload)`. Payloads arrive untyped over IPC; `TPayload` narrows the call site
 * — the hook performs no runtime validation (the plugin owns the shape it
 * pushes, mirroring `useHostChannel`'s host-owns-validation contract).
 */
export type PluginEventHandler<TPayload> = (payload: TPayload) => void;

/**
 * Keys of {@link PluginThemeTokens}: Daintree's semantic theme tokens, the
 * same names as the `--theme-*` CSS variables without the prefix. The surface,
 * text, border, accent, `focus-ring` and status keys are core and stable within
 * the major version; the activity, terminal (ANSI included), syntax and
 * category keys are extended, provided best effort, and may be renamed in a
 * minor version with the change noted.
 */
export type PluginThemeTokenKey =
  | "surface-grid"
  | "surface-sidebar"
  | "surface-canvas"
  | "surface-panel"
  | "surface-panel-elevated"
  | "surface-input"
  | "surface-inset"
  | "surface-hover"
  | "surface-active"
  | "text-primary"
  | "text-secondary"
  | "text-muted"
  | "text-placeholder"
  | "text-inverse"
  | "text-link"
  | "border-default"
  | "border-subtle"
  | "border-strong"
  | "border-divider"
  | "border-interactive"
  | "accent-primary"
  | "accent-foreground"
  | "accent-hover"
  | "accent-soft"
  | "accent-muted"
  | "focus-ring"
  | "status-success"
  | "status-warning"
  | "status-danger"
  | "status-info"
  | "activity-active"
  | "activity-idle"
  | "activity-working"
  | "activity-waiting"
  | "terminal-background"
  | "terminal-foreground"
  | "terminal-muted"
  | "terminal-cursor"
  | "terminal-selection"
  | "terminal-black"
  | "terminal-red"
  | "terminal-green"
  | "terminal-yellow"
  | "terminal-blue"
  | "terminal-magenta"
  | "terminal-cyan"
  | "terminal-white"
  | "terminal-bright-black"
  | "terminal-bright-red"
  | "terminal-bright-green"
  | "terminal-bright-yellow"
  | "terminal-bright-blue"
  | "terminal-bright-magenta"
  | "terminal-bright-cyan"
  | "terminal-bright-white"
  | "syntax-comment"
  | "syntax-punctuation"
  | "syntax-number"
  | "syntax-string"
  | "syntax-operator"
  | "syntax-keyword"
  | "syntax-function"
  | "syntax-link"
  | "syntax-quote"
  | "category-blue"
  | "category-purple"
  | "category-cyan"
  | "category-green"
  | "category-amber"
  | "category-orange"
  | "category-teal"
  | "category-indigo"
  | "category-rose"
  | "category-pink"
  | "category-violet"
  | "category-slate";

/**
 * Resolved colours of the active theme, for canvas and WebGL. Each value is a
 * concrete sRGB colour, `#rrggbb` when opaque or `rgba(r, g, b, a)` when not,
 * so it parses anywhere. `category-*` is a 12-hue ramp for charts and tags.
 */
export type PluginThemeTokens = Readonly<Record<PluginThemeTokenKey, string>>;

/** What `useDaintreeTheme()` and `getDaintreeTheme()` return. Replaced, never mutated. */
export interface PluginDaintreeTheme {
  readonly colorMode: "dark" | "light";
  /** The active theme's id (a built-in such as `"daintree"`, or a custom theme's id). */
  readonly themeId: string;
  readonly tokens: PluginThemeTokens;
}

/** The id type `useSelection` keys rows by. */
export type PluginSelectionKey = string | number;

/**
 * A click or key that changes a selection. Only the modifiers and `key` are
 * read, so a DOM event, a React event or a plain object all work.
 */
export interface PluginSelectionGesture {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  /** `" "` (Space) toggles the row rather than replacing the selection. */
  key?: string;
}

export interface UseSelectionOptions<K extends PluginSelectionKey = string> {
  /**
   * Every row's id, in the order the rows are shown. Ranges and "select all"
   * walk this order, and `selected` only ever holds ids in it: a row filtered
   * out of view drops out of `selected` until it is back.
   */
  ids: readonly K[];
  /** `multiple` (the default) or `single`, where choosing a row replaces the last. */
  mode?: "single" | "multiple";
  /** Controlled selection. Pair with `onSelectedChange`. */
  selected?: readonly K[];
  /** The starting selection when uncontrolled. */
  defaultSelected?: readonly K[];
  /** Every change, as the new ids in row order. */
  onSelectedChange?: (selected: K[]) => void;
  /** Rows that cannot be selected: ranges and "select all" skip them. */
  isDisabled?: (id: K) => boolean;
}

/** Props `useSelection().getItemProps(id)` hands a row that has no `useListNavigation`. */
export interface PluginSelectionItemProps {
  "aria-selected": boolean;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

export interface UseSelectionResult<K extends PluginSelectionKey = string> {
  /** The selected ids, in row order. */
  selected: K[];
  /** How many rows are selected. */
  count: number;
  /** The row the next Shift-click or Shift+Arrow extends from, or null. */
  anchor: K | null;
  isSelected: (id: K) => boolean;
  /** Every selectable row is selected (false for an empty list). */
  allSelected: boolean;
  /** Adds or removes one row, and makes it the anchor. */
  toggle: (id: K) => void;
  /** Replaces the selection with these rows; the first becomes the anchor. */
  select: (ids: K | readonly K[]) => void;
  /**
   * Selects from the anchor to `id`, replacing the last range but keeping
   * rows Cmd/Ctrl-clicked before it. `additive` keeps the whole current
   * selection as well. With no anchor it selects `id` alone.
   */
  selectRange: (id: K, options?: { additive?: boolean }) => void;
  selectAll: () => void;
  clear: () => void;
  /**
   * A click or Enter/Space on a row, read the platform way: plain replaces
   * the selection, Cmd (Ctrl elsewhere) or Space toggles, Shift selects a
   * range from the anchor and Shift with Cmd/Ctrl adds the range. Pass it as
   * `useListNavigation`'s `onSelect` (mapping the index to an id).
   */
  handleSelect: (id: K, gesture?: PluginSelectionGesture) => void;
  /**
   * The keyboard cursor arrived on `id`. With Shift held it selects the range
   * from the anchor; otherwise it does nothing, so the cursor moves without
   * changing the selection. Pass it as `useListNavigation`'s
   * `onActiveIndexChange`.
   */
  handleNavigate: (id: K, gesture?: PluginSelectionGesture) => void;
  /** `aria-selected` and a click handler for a row you draw without `useListNavigation`. */
  getItemProps: (id: K) => PluginSelectionItemProps;
}

/** One view-scoped shortcut: a canonical combo and what it does. */
export interface PluginHotkey {
  /**
   * The app's chord notation, as `KbdChord` draws it: `"Delete"`,
   * `"Cmd+A"`, `"Cmd+Shift+Z"`. `Cmd` is Command on macOS and Ctrl
   * elsewhere; `Ctrl` is the Control key everywhere; `Alt` is Option on
   * macOS. Single combos only, not two-step chords.
   */
  combo: string;
  /** Runs on the key. The default is prevented unless you return `false`. */
  handler: (event: globalThis.KeyboardEvent) => void | boolean;
  /** Also fires while focus is in a text field. Defaults to false. */
  allowInInput?: boolean;
  /** Skips the binding without re-rendering to remove it. */
  disabled?: boolean;
}

export interface UseHotkeysOptions {
  /**
   * Where the keys work: while focus is inside this element. Omitted, they
   * work anywhere in your view.
   */
  scope?: { readonly current: HTMLElement | null };
  /** Turns every binding off at once. Defaults to true. */
  enabled?: boolean;
}

export interface UseUndoRedoOptions {
  /** Most undo steps kept; older ones fall off. Defaults to 100. */
  limit?: number;
  /**
   * How long, in ms, pushes with the same `coalesce` key keep merging into
   * one step. Defaults to 1000.
   */
  coalesceMs?: number;
}

export interface PluginUndoRedoPushOptions {
  /**
   * Pushes with the same key inside `coalesceMs` of each other make one undo
   * step, so typing a word is one undo rather than one per letter.
   */
  coalesce?: string;
}

export interface UseUndoRedoResult<T> {
  /** The current value. */
  value: T;
  /** Records a new value as a step. A function gets the current value. */
  push: (next: T | ((current: T) => T), options?: PluginUndoRedoPushOptions) => void;
  /** Steps back and returns the value it restored, or undefined when there is none. */
  undo: () => T | undefined;
  /** Steps forward again and returns the value, or undefined when there is none. */
  redo: () => T | undefined;
  canUndo: boolean;
  canRedo: boolean;
  /** Forgets every step and starts again from `value` (the current one when omitted). */
  reset: (value?: T) => void;
}

export interface UseDisclosureOptions {
  /** Controlled. Pair with `onOpenChange`. */
  open?: boolean;
  defaultOpen?: boolean;
  /**
   * Hears each requested change from what is rendered. A controlled owner can
   * decline one by keeping `open` as it is, and still hears the next.
   */
  onOpenChange?: (open: boolean) => void;
}

export interface UseDisclosureResult {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onToggle: () => void;
  /** The kit overlays' own callback: spread `{ open, onOpenChange }` onto a `Popover`. */
  onOpenChange: (open: boolean) => void;
}

export interface UseDebouncedCallbackOptions {
  /** Also run on the first call of a burst. Defaults to false (trailing only). */
  leading?: boolean;
  /** The longest a burst can hold a call back, in ms. */
  maxWait?: number;
}

/** A debounced function from `useDebouncedCallback`. Identity is stable for the life of the component. */
export type PluginDebouncedCallback<A extends unknown[]> = ((...args: A) => void) & {
  /** Drops the pending call. */
  cancel: () => void;
  /** Runs the pending call now, if there is one. */
  flush: () => void;
  /** Whether a call is waiting. */
  isPending: () => boolean;
};

/** The tone of a view toast, which picks its glyph and colour. */
export type PluginToastTone = "info" | "success" | "warning" | "error";

export interface PluginViewToastOptions {
  /** One or two sentences. Daintree prefixes your plugin's name. */
  message: string;
  /** Defaults to `info`. */
  tone?: PluginToastTone;
  /**
   * How long it stays up, in ms; longer than 60 seconds is 60 seconds.
   * Defaults to the app's time for the tone, or, with an `action`, until the
   * user answers it.
   */
  durationMs?: number;
  /**
   * One button on the toast. It closes the toast. A toast with an action
   * stays up until the user answers it unless you pass `durationMs`.
   */
  action?: { label: string; onClick: () => void };
}

export interface PluginUndoToastOptions {
  /** What just happened, past tense: `"3 snippets deleted"`. */
  message: string;
  /** Puts it back. Runs at most once, and only while the toast is up. */
  onUndo: () => void;
}

/** A toast `useToast` put up. */
export interface PluginToastHandle {
  /** Takes it down if it is still up. */
  dismiss: () => void;
}

export interface UseToastResult {
  show: (options: PluginViewToastOptions) => PluginToastHandle;
  /** A success toast with an Undo button. A plugin has one up at a time; a new one replaces the last. */
  showUndo: (options: PluginUndoToastOptions) => PluginToastHandle;
}
