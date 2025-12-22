import type { PanelKind, BuiltInPanelKind } from "../types/domain.js";
import { getAgentConfig } from "./agentRegistry.js";

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
  /** Brand/accent color (hex) */
  color: string;
  /** Whether this panel kind uses a PTY process */
  hasPty: boolean;
  /** Whether this panel kind can be restarted */
  canRestart: boolean;
  /** Whether this panel kind can convert to/from other types */
  canConvert: boolean;
  /** Extension ID if this is an extension-provided panel kind */
  extensionId?: string;
  /** Keyboard shortcut (optional) */
  shortcut?: string;
}

/**
 * Registry of panel kind configurations.
 * Built-in kinds are registered at startup.
 * Extensions can register additional kinds at runtime.
 */
const PANEL_KIND_REGISTRY: Record<string, PanelKindConfig> = {
  terminal: {
    id: "terminal",
    name: "Terminal",
    iconId: "terminal",
    color: "#6b7280", // gray-500
    hasPty: true,
    canRestart: true,
    canConvert: true,
  },
  agent: {
    id: "agent",
    name: "Agent",
    iconId: "agent",
    color: "#CC785C", // Default agent color, overridden by agentId lookup
    hasPty: true,
    canRestart: true,
    canConvert: true,
  },
  browser: {
    id: "browser",
    name: "Browser",
    iconId: "globe",
    color: "#3b82f6", // blue-500
    hasPty: false,
    canRestart: false,
    canConvert: false,
  },
};

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
  return "#6b7280"; // gray-500
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
 * Get all built-in panel kinds.
 */
export function getBuiltInPanelKinds(): BuiltInPanelKind[] {
  return ["terminal", "agent", "browser"];
}
