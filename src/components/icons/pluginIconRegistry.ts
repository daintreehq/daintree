import {
  FileDiff,
  FileText,
  FolderGit2,
  FolderTree,
  Gauge,
  GitPullRequest,
  Globe,
  LayoutPanelTop,
  List,
  Monitor,
  MonitorPlay,
  Package,
  Puzzle,
  Sparkles,
  SquareTerminal,
  StickyNote,
} from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import { PLUGIN_ICON_IDS, type PluginIconId } from "@shared/config/pluginIconIds";
// Imported from the module rather than `@/components/icons` so the barrel can
// keep importing this file's neighbours without a cycle.
import { DaintreeIcon } from "./DaintreeIcon";

export interface PluginIconProps {
  className?: string;
  size?: number;
  width?: number;
  height?: number;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
}

export type PluginIconComponent = ComponentType<PluginIconProps>;

/**
 * The one id → glyph map behind every surface that renders a plugin-declared
 * icon: the panel palette, panel headers/tabs/dock, toolbar buttons, the
 * toolbar overflow menu, and toolbar settings. Typed against
 * {@link PluginIconId} so an id added to `PLUGIN_ICON_IDS` without a glyph — or
 * a glyph without an id — is a typecheck failure, not a silent fallback.
 */
export const PLUGIN_ICON_COMPONENTS = {
  terminal: SquareTerminal,
  package: Package,
  puzzle: Puzzle,
  globe: Globe,
  monitor: Monitor,
  "monitor-play": MonitorPlay,
  "file-text": FileText,
  "file-diff": FileDiff,
  "folder-tree": FolderTree,
  "git-branch": FolderGit2,
  "git-pull-request": GitPullRequest,
  "sticky-note": StickyNote,
  gauge: Gauge,
  list: List,
  sparkles: Sparkles,
  "layout-panel-top": LayoutPanelTop,
  daintree: DaintreeIcon,
} satisfies Record<PluginIconId, PluginIconComponent>;

/**
 * Fallback for plugin-identity surfaces (toolbar buttons, toolbar settings,
 * the plugin catalog). A generic package reads as "some plugin contributed
 * this", which an unrelated app glyph does not.
 */
export const DEFAULT_PLUGIN_ICON = Package;

/**
 * Fallback for general panel chrome. Panel surfaces also render built-ins,
 * agents, processes, and resume entries, where a terminal glyph — not a
 * package — is the honest default.
 */
export const DEFAULT_PANEL_ICON = SquareTerminal;

/**
 * The glyph for `id`, or `undefined` when `id` names no registered icon.
 * `Object.hasOwn` rather than a bare index: `iconId` is attacker-adjacent
 * manifest input, and a plain lookup would resolve `"toString"` or
 * `"constructor"` to an inherited function and render garbage.
 */
export function getPluginIconComponent(
  id: string | null | undefined
): PluginIconComponent | undefined {
  if (!id || !Object.hasOwn(PLUGIN_ICON_COMPONENTS, id)) return undefined;
  return (PLUGIN_ICON_COMPONENTS as Record<string, PluginIconComponent>)[id];
}

/** The glyph for `id`, falling back to `fallback` when `id` isn't registered. */
export function resolvePluginIcon(
  id: string | null | undefined,
  fallback: PluginIconComponent = DEFAULT_PLUGIN_ICON
): PluginIconComponent {
  return getPluginIconComponent(id) ?? fallback;
}

export { PLUGIN_ICON_IDS, type PluginIconId };
