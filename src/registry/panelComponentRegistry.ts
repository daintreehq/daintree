import React, { type ComponentType, type ReactNode } from "react";
import type { PanelKind } from "@/types";

/**
 * Props passed to panel content components.
 */
export interface PanelComponentProps {
  id: string;
  title: string;
  isFocused: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock";
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
  gridPanelCount?: number;
  isTrashing?: boolean;
  [key: string]: unknown;
}

/**
 * Registration for a panel component.
 * Uses ComponentType<any> to allow components with stricter prop requirements
 * (e.g., TerminalPane requires cwd, BrowserPane requires initialUrl).
 * Type safety is maintained at the registration site.
 */
export interface PanelComponentRegistration {
  /** The panel content component */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
}

/**
 * Registry of panel components by kind.
 * Built-in kinds are registered at startup.
 * Extensions can register additional kinds at runtime.
 * Uses Map to prevent prototype pollution.
 */
const PANEL_COMPONENT_REGISTRY = new Map<string, PanelComponentRegistration>();

/**
 * Register a panel component for a given kind.
 * Used by extensions to add custom panel types.
 *
 * @param kind - The panel kind to register
 * @param registration - The component registration
 * @param options - Registration options
 */
export function registerPanelComponent(
  kind: PanelKind,
  registration: PanelComponentRegistration,
  options: { allowOverride?: boolean } = {}
): void {
  if (PANEL_COMPONENT_REGISTRY.has(kind) && !options.allowOverride) {
    console.warn(`Panel component for kind "${kind}" already registered, overwriting`);
  }
  PANEL_COMPONENT_REGISTRY.set(kind, registration);
}

/**
 * Get the component registration for a panel kind.
 *
 * @param kind - The panel kind to look up
 * @returns The component registration, or undefined if not registered
 */
export function getPanelComponent(kind: PanelKind): PanelComponentRegistration | undefined {
  return PANEL_COMPONENT_REGISTRY.get(kind);
}

/**
 * Check if a panel component is registered for a kind.
 *
 * @param kind - The panel kind to check
 * @returns True if a component is registered
 */
export function hasPanelComponent(kind: PanelKind): boolean {
  return PANEL_COMPONENT_REGISTRY.has(kind);
}

/**
 * Get all registered panel kinds that have components.
 *
 * @returns Array of panel kinds with registered components
 */
export function getRegisteredPanelKinds(): string[] {
  return Array.from(PANEL_COMPONENT_REGISTRY.keys());
}

/**
 * Render a panel component for a given kind.
 * Returns null if no component is registered.
 *
 * @param kind - The panel kind
 * @param props - Props to pass to the component
 * @returns The rendered component or null
 */
export function renderPanelComponent(
  kind: PanelKind,
  props: PanelComponentProps
): ReactNode | null {
  const registration = getPanelComponent(kind);
  if (!registration) return null;

  const Component = registration.component;
  return React.createElement(Component, props);
}
