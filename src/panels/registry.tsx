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
}
