import { Suspense, lazy, type ComponentType } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PtyPanelData, BrowserPanelData, DevPreviewPanelData } from "@shared/types/panel";
import type {
  TerminalPanelOptions,
  BrowserPanelOptions,
  DevPreviewPanelOptions,
} from "@shared/types/addPanelOptions";
import type { PanelSnapshot } from "@shared/types/project";
import { TerminalPane } from "@/components/Terminal/TerminalPane";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BrowserPaneSkeleton } from "@/components/Browser/BrowserPaneSkeleton";

import { serializePtyPanel } from "./terminal/serializer";
import { createTerminalDefaults } from "./terminal/defaults";
import { serializeBrowser } from "./browser/serializer";
import { createBrowserDefaults } from "./browser/defaults";
import { serializeDevPreview } from "./dev-preview/serializer";
import { createDevPreviewDefaults } from "./dev-preview/defaults";

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
  extensionState?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PanelKindDefinition extends PanelKindConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
}

const LazyBrowserPane = lazy(() =>
  import("@/components/Browser/BrowserPane").then((m) => ({ default: m.BrowserPane }))
);
const LazyDevPreviewPane = lazy(() =>
  import("@/components/DevPreview/DevPreviewPane").then((m) => ({ default: m.DevPreviewPane }))
);

// Wrapper providing Suspense fallback for the lazy dynamic import and
// correct componentName attribution on chunk-load failures. The per-panel
// boundary in GridPanel catches render errors; this wrapper catches import
// failures with proper attribution — the two boundaries serve different roles.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function BrowserPaneWrapper(props: any) {
  return (
    <ErrorBoundary variant="component" componentName="BrowserPane">
      <Suspense fallback={<BrowserPaneSkeleton />}>
        <LazyBrowserPane {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DevPreviewPaneWrapper(props: any) {
  return (
    <ErrorBoundary variant="component" componentName="DevPreviewPane">
      <Suspense fallback={<BrowserPaneSkeleton label="Loading dev preview panel" />}>
        <LazyDevPreviewPane {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Maps each built-in panel kind to its panel data variant. `createdAt` is
 * intentionally widened on the PTY and dev-preview entries so serializers can
 * read the legacy field without modifying the shared variant interfaces.
 */
interface BuiltInPanelMap {
  terminal: PtyPanelData & { createdAt?: number };
  browser: BrowserPanelData;
  "dev-preview": DevPreviewPanelData & { createdAt?: number };
}

interface BuiltInPanelOptionsMap {
  terminal: TerminalPanelOptions;
  browser: BrowserPanelOptions;
  "dev-preview": DevPreviewPanelOptions;
}

type BuiltInSerializeDefaults = {
  [K in keyof BuiltInPanelMap]: {
    serialize: (panel: BuiltInPanelMap[K]) => Partial<PanelSnapshot>;
    createDefaults: (options: BuiltInPanelOptionsMap[K]) => Partial<BuiltInPanelMap[K]>;
  };
};

const BUILT_IN_SERIALIZE_DEFAULTS = {
  terminal: { serialize: serializePtyPanel, createDefaults: createTerminalDefaults },
  browser: { serialize: serializeBrowser, createDefaults: createBrowserDefaults },
  "dev-preview": { serialize: serializeDevPreview, createDefaults: createDevPreviewDefaults },
} satisfies BuiltInSerializeDefaults;

export function initBuiltInPanelKinds(): void {
  for (const [kindId, hooks] of Object.entries(BUILT_IN_SERIALIZE_DEFAULTS)) {
    const existing = requirePanelKindConfig(kindId);
    // Narrow per-kind hooks are widened to the shared PanelKindConfig contract
    // here — this is the single seam between the typed registry map above and
    // the extension-friendly wide interface. Function parameter contravariance
    // makes this cast necessary; it is intentionally isolated to this function.
    const serialize = hooks.serialize as PanelKindConfig["serialize"];
    const createDefaults = hooks.createDefaults as PanelKindConfig["createDefaults"];
    if (existing.serialize !== serialize || existing.createDefaults !== createDefaults) {
      existing.serialize = serialize;
      existing.createDefaults = createDefaults;
    }
  }
}

function requirePanelKindConfig(kind: string): PanelKindConfig {
  const config = getPanelKindConfig(kind);
  if (!config) {
    throw new Error(`Built-in panel kind "${kind}" not found in shared registry`);
  }
  return config;
}

const PANEL_KIND_DEFINITION_REGISTRY: Record<string, PanelKindDefinition> = {
  terminal: { ...requirePanelKindConfig("terminal"), component: TerminalPane },
  browser: { ...requirePanelKindConfig("browser"), component: BrowserPaneWrapper },
  "dev-preview": { ...requirePanelKindConfig("dev-preview"), component: DevPreviewPaneWrapper },
};

/**
 * Reactive snapshot for `useSyncExternalStore`. Replaced (not mutated) on
 * every registry change so React's `Object.is` identity check schedules a
 * rerender — components observing this snapshot then re-evaluate
 * `getPanelKindDefinition(kind)` and pick up newly-registered plugin panels
 * without needing a window reload.
 */
let definitionsSnapshot: Readonly<Record<string, PanelKindDefinition>> = {
  ...PANEL_KIND_DEFINITION_REGISTRY,
};
const definitionListeners = new Set<() => void>();

function notifyDefinitionListeners(): void {
  definitionsSnapshot = { ...PANEL_KIND_DEFINITION_REGISTRY };
  for (const listener of definitionListeners) {
    try {
      listener();
    } catch (err) {
      console.warn("[panelKindRegistry] definition listener threw:", err);
    }
  }
}

/**
 * Subscribe to panel kind definition registry changes. Stable function
 * reference (module-scope) so `useSyncExternalStore` doesn't re-subscribe
 * on every render.
 */
export function subscribeToPanelKindDefinitions(listener: () => void): () => void {
  definitionListeners.add(listener);
  return () => {
    definitionListeners.delete(listener);
  };
}

/**
 * Snapshot for `useSyncExternalStore`. Returns the same reference until a
 * registration changes the registry; React uses identity comparison to
 * detect changes.
 */
export function getPanelKindDefinitionsSnapshot(): Readonly<Record<string, PanelKindDefinition>> {
  return definitionsSnapshot;
}

export function getPanelKindDefinition(kind: string): PanelKindDefinition | undefined {
  return PANEL_KIND_DEFINITION_REGISTRY[kind];
}

export function getPanelKindDefinitions(): PanelKindDefinition[] {
  return Object.values(PANEL_KIND_DEFINITION_REGISTRY);
}

export function registerPanelKindDefinition(definition: PanelKindDefinition): void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPanelKindDefinition(kindId: string, component: ComponentType<any>): void;
export function registerPanelKindDefinition(
  definitionOrKindId: PanelKindDefinition | string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component?: ComponentType<any>
): void {
  let definition: PanelKindDefinition;
  if (typeof definitionOrKindId === "string") {
    const config = getPanelKindConfig(definitionOrKindId);
    if (!config) {
      console.warn(
        `[panelKindRegistry] Cannot register definition for "${definitionOrKindId}": not found in shared registry`
      );
      return;
    }
    definition = { ...config, component: component! };
  } else {
    definition = definitionOrKindId;
  }

  if (PANEL_KIND_DEFINITION_REGISTRY[definition.id]) {
    console.warn(`Panel kind definition "${definition.id}" already registered, overwriting`);
  }
  PANEL_KIND_DEFINITION_REGISTRY[definition.id] = definition;
  notifyDefinitionListeners();
}

/**
 * Remove a panel kind definition. Used when a plugin unregisters a kind so
 * `getPanelKindDefinition` falls back to `undefined` and panel components
 * render their `PluginMissingPanel` placeholder again.
 *
 * Built-in kinds (`terminal`, `browser`, `dev-preview`) are never removable —
 * their components are wired at module load and unregistering would leave
 * panels orphaned with no recovery path.
 */
export function unregisterPanelKindDefinition(kindId: string): boolean {
  if (kindId === "terminal" || kindId === "browser" || kindId === "dev-preview") {
    return false;
  }
  if (!(kindId in PANEL_KIND_DEFINITION_REGISTRY)) {
    return false;
  }
  delete PANEL_KIND_DEFINITION_REGISTRY[kindId];
  notifyDefinitionListeners();
  return true;
}
