import { BUILT_IN_PANEL_KINDS } from "../config/panelKindRegistry.js";
import type { PluginFocusedPanel, PluginFocusedPanelKind } from "../types/plugin.js";

/** Nothing that is a panel has focus, or Daintree is not the foreground window. */
export const NO_FOCUSED_PANEL: PluginFocusedPanel = Object.freeze({
  kind: null,
  agent: false,
  worktreeId: null,
});

const BUILT_IN_KIND_SET: ReadonlySet<string> = new Set(BUILT_IN_PANEL_KINDS);

/**
 * Collapse any panel kind to what a plugin may see: a built-in kind as-is,
 * `"portal"` as-is, and every other string to `"plugin"`. A plugin kind is
 * `{manifestId}.{kindId}` or `project:{projectId}/…`, so passing it through
 * would name another plugin and the project.
 */
export function toPluginFocusedPanelKind(kind: unknown): PluginFocusedPanelKind | null {
  if (typeof kind !== "string" || kind.length === 0) return null;
  if (kind === "portal" || BUILT_IN_KIND_SET.has(kind)) return kind as PluginFocusedPanelKind;
  return "plugin";
}

/**
 * Build a frozen {@link PluginFocusedPanel} from an untrusted value (a renderer
 * report, or a payload rebuilt by the worker port's structured clone) by
 * explicit assignment, never a spread, so no extra field survives.
 */
export function toPluginFocusedPanel(value: unknown): PluginFocusedPanel {
  if (!value || typeof value !== "object") return NO_FOCUSED_PANEL;
  const raw = value as { kind?: unknown; agent?: unknown; worktreeId?: unknown };
  const focusKind = toPluginFocusedPanelKind(raw.kind);
  if (focusKind === null) return NO_FOCUSED_PANEL;
  return Object.freeze({
    kind: focusKind,
    // Agent-ness is a terminal state, so no other kind can carry it.
    agent: focusKind === "terminal" && raw.agent === true,
    worktreeId:
      focusKind !== "portal" && typeof raw.worktreeId === "string" && raw.worktreeId.length > 0
        ? raw.worktreeId
        : null,
  });
}

export function pluginFocusedPanelEquals(a: PluginFocusedPanel, b: PluginFocusedPanel): boolean {
  return a.kind === b.kind && a.agent === b.agent && a.worktreeId === b.worktreeId;
}
