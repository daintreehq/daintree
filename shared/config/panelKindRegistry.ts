import type { PanelKind, BuiltInPanelKind, TerminalInstance } from "../types/panel.js";
import type { TerminalSnapshot } from "../types/project.js";
import type { AddPanelOptions } from "../types/addPanelOptions.js";
import { getAgentConfig } from "./agentRegistry.js";
import { PANEL_KIND_BRAND_COLORS } from "../theme/index.js";

/**
 * Configuration for a panel kind.
 * Extensions can register new panel kinds with custom configurations.
 */
export interface PanelKindConfig {
  /** Unique identifier for this panel kind */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Icon identifier (for TerminalIcon/PanelIcon component) */
  iconId: string;
  /** Brand/accent color */
  color: string;
  /** Whether this panel kind uses a PTY process */
  hasPty: boolean;
  /** Whether this panel kind can be restarted */
  canRestart: boolean;
  /** Whether this panel kind can convert to/from other types */
  canConvert: boolean;
  /** Whether this panel kind uses the standard terminal UI */
  usesTerminalUi?: boolean;
  /** Whether this panel kind should keep its runtime alive across project switches */
  keepAliveOnProjectSwitch?: boolean;
  /** Whether this panel kind should appear in the panel palette (⌘⇧P). Set to false for panels with dedicated spawn actions (terminal, agent). Defaults to true for extension panels if not specified. */
  showInPalette?: boolean;
  /** Extension ID if this is an extension-provided panel kind */
  extensionId?: string;
  /** Keyboard shortcut (optional) */
  shortcut?: string;
  /** Search aliases for fuzzy matching in the panel palette */
  searchAliases?: string[];
  /** Serialize kind-specific fields from a panel instance into a snapshot fragment */
  serialize?: (panel: TerminalInstance) => Partial<TerminalSnapshot>;
  /**
   * Factory that returns kind-specific fields for a new panel instance.
   * Common fields (id, title, location, worktreeId, isVisible, runtimeStatus, extensionState)
   * are injected by addTerminal — this only returns the kind-specific diff.
   * Optional: unregistered/extension kinds fall back to getExtensionFallbackDefaults.
   */
  createDefaults?: (options: AddPanelOptions) => Partial<TerminalInstance>;
}

/**
 * Registry of panel kind configurations.
 * Built-in kinds are registered at startup with metadata only.
 * Serialize and createDefaults hooks are injected by the renderer
 * via initBuiltInPanelKinds() in src/panels/registry.tsx.
 * Extensions can register additional kinds at runtime.
 */
const PANEL_KIND_REGISTRY: Record<string, PanelKindConfig> = {
  terminal: {
    id: "terminal",
    name: "Terminal",
    iconId: "terminal",
    color: PANEL_KIND_BRAND_COLORS.terminal,
    hasPty: true,
    canRestart: true,
    canConvert: true,
    keepAliveOnProjectSwitch: true,
    showInPalette: false,
  },
  agent: {
    id: "agent",
    name: "Agent",
    iconId: "agent",
    color: PANEL_KIND_BRAND_COLORS.agent,
    hasPty: true,
    canRestart: true,
    canConvert: true,
    keepAliveOnProjectSwitch: true,
    showInPalette: false,
  },
  browser: {
    id: "browser",
    name: "Browser",
    iconId: "globe",
    color: PANEL_KIND_BRAND_COLORS.browser,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["web", "chrome", "internet", "www"],
  },
  notes: {
    id: "notes",
    name: "Notes",
    iconId: "sticky-note",
    color: PANEL_KIND_BRAND_COLORS.notes,
    hasPty: false,
    canRestart: false,
    canConvert: false,
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["md", "markdown", "text", "memo"],
  },
  "dev-preview": {
    id: "dev-preview",
    name: "Dev Preview",
    iconId: "monitor",
    color: PANEL_KIND_BRAND_COLORS["dev-preview"],
    hasPty: false,
    canRestart: false,
    canConvert: false,
    usesTerminalUi: false,
    keepAliveOnProjectSwitch: true,
    showInPalette: true,
    searchAliases: ["localhost", "server", "preview", "port"],
  },
};

/**
 * Default fields for extension panel kinds that don't provide a createDefaults factory.
 */
export function getExtensionFallbackDefaults(): Partial<TerminalInstance> {
  return {};
}

/**
 * Register a new panel kind configuration.
 * Used by extensions to add custom panel types.
 *
 * @param config - The panel kind configuration to register
 */
export function registerPanelKind(config: PanelKindConfig): void {
  if (PANEL_KIND_REGISTRY[config.id]) {
    console.warn(`Panel kind "${config.id}" already registered, overwriting`);
  }
  PANEL_KIND_REGISTRY[config.id] = config;
}

/**
 * Unregister all panel kinds owned by a given plugin.
 * Only removes entries whose `extensionId` matches. Built-in panel kinds
 * have no `extensionId` and will never match a real plugin ID. The input
 * guard rejects empty or non-string pluginIds so a caller that accidentally
 * passes `undefined` (via a type cast or JS-side mistake) cannot match
 * built-in entries whose `extensionId` is also `undefined`.
 *
 * @param pluginId - The plugin whose contributed panel kinds should be removed
 */
export function unregisterPluginPanelKinds(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  for (const [key, config] of Object.entries(PANEL_KIND_REGISTRY)) {
    if (config.extensionId === pluginId) {
      delete PANEL_KIND_REGISTRY[key];
    }
  }
}

/**
 * Get the configuration for a panel kind.
 *
 * @param kind - The panel kind to look up
 * @returns The panel kind configuration, or undefined if not registered
 */
export function getPanelKindConfig(kind: PanelKind): PanelKindConfig | undefined {
  return PANEL_KIND_REGISTRY[kind];
}

/**
 * Get all registered panel kind IDs.
 *
 * @returns Array of registered panel kind IDs
 */
export function getPanelKindIds(): string[] {
  return Object.keys(PANEL_KIND_REGISTRY);
}

/**
 * Check if a panel kind is registered.
 *
 * @param kind - The panel kind to check
 * @returns True if the panel kind is registered
 */
export function isRegisteredPanelKind(kind: PanelKind): boolean {
  return kind in PANEL_KIND_REGISTRY;
}

/**
 * Get the default title for a panel based on its kind and optional agent ID.
 *
 * @param kind - The panel kind
 * @param agentId - Optional agent ID for agent panels
 * @returns The default title for the panel
 */
export function getDefaultPanelTitle(kind: PanelKind, agentId?: string): string {
  // Agent panels use agent-specific title
  if (kind === "agent" && agentId) {
    const agentConfig = getAgentConfig(agentId);
    if (agentConfig) return agentConfig.name;
  }

  // Look up in panel kind registry
  const config = getPanelKindConfig(kind);
  if (config) return config.name;

  // Fallback for unknown kinds: capitalize first letter
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * Get the color for a panel based on its kind and optional agent ID.
 *
 * @param kind - The panel kind
 * @param agentId - Optional agent ID for agent panels
 * @returns The hex color for the panel
 */
export function getPanelKindColor(kind: PanelKind, agentId?: string): string {
  // Agent panels use agent-specific color
  if (kind === "agent" && agentId) {
    const agentConfig = getAgentConfig(agentId);
    if (agentConfig) return agentConfig.color;
  }

  // Look up in panel kind registry
  const config = getPanelKindConfig(kind);
  if (config) return config.color;

  // Fallback for unknown kinds
  return PANEL_KIND_BRAND_COLORS.terminal;
}

/**
 * Check if a panel kind requires a PTY process.
 *
 * @param kind - The panel kind to check
 * @returns True if the panel kind uses PTY
 */
export function panelKindHasPty(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  return config?.hasPty ?? false;
}

/**
 * Check if a panel kind can be restarted via the UI.
 * Uses the panel kind registry's canRestart property as the source of truth.
 *
 * This indicates the panel kind's restart capability at the architecture level.
 * UI components should still gate restart affordances on both this capability flag
 * AND the availability of an onRestart handler for the specific panel instance.
 *
 * @param kind - The panel kind to check
 * @returns True if the panel kind supports restart, false otherwise (including unregistered kinds)
 *
 * @example
 * // Terminal and agent panels can be restarted
 * panelKindCanRestart('terminal') // true
 * panelKindCanRestart('agent')    // true
 *
 * // Browser panels cannot be restarted
 * panelKindCanRestart('browser')  // false
 *
 * // Dev-preview panels manage their own restart internally
 * panelKindCanRestart('dev-preview') // false
 *
 * @example
 * // UI usage - gate on both capability and handler
 * const canRestart = panelKindCanRestart(kind);
 * {canRestart && onRestart && <button onClick={onRestart}>Restart</button>}
 */
export function panelKindCanRestart(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  return config?.canRestart ?? false;
}

/**
 * Check if a panel kind uses the standard terminal UI.
 */
export function panelKindUsesTerminalUi(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  if (!config) return false;
  return config.usesTerminalUi ?? config.hasPty;
}

/**
 * Check if a panel kind should keep its runtime alive across project switches.
 */
export function panelKindKeepsAliveOnProjectSwitch(kind: PanelKind): boolean {
  const config = getPanelKindConfig(kind);
  if (!config) return false;
  return config.keepAliveOnProjectSwitch ?? config.hasPty;
}

/**
 * Get all built-in panel kinds.
 */
export function getBuiltInPanelKinds(): BuiltInPanelKind[] {
  return ["terminal", "agent", "browser", "notes", "dev-preview"];
}

/**
 * Remove all extension-contributed panel kinds while preserving built-ins.
 *
 * Built-in entries have no `extensionId` field, so this deletes only entries
 * registered via plugins. Intended for test cleanup — in a singleFork Vitest
 * pool the module-level registry persists across tests, so integration tests
 * must clear extension entries between cases.
 */
export function clearPanelKindRegistry(): void {
  for (const [key, config] of Object.entries(PANEL_KIND_REGISTRY)) {
    if (config.extensionId !== undefined) {
      delete PANEL_KIND_REGISTRY[key];
    }
  }
}
