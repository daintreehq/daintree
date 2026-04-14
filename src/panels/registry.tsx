import { Suspense, lazy, type ComponentType } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { TerminalPane } from "@/components/Terminal/TerminalPane";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BrowserPaneSkeleton } from "@/components/Browser/BrowserPaneSkeleton";
import { NotesPaneSkeleton } from "@/components/Notes/NotesPaneSkeleton";

import { serializePtyPanel } from "./terminal/serializer";
import { createTerminalDefaults } from "./terminal/defaults";
import { serializeAgent } from "./agent/serializer";
import { createAgentDefaults } from "./agent/defaults";
import { serializeBrowser } from "./browser/serializer";
import { createBrowserDefaults } from "./browser/defaults";
import { serializeNotes } from "./notes/serializer";
import { createNotesDefaults } from "./notes/defaults";
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
const LazyNotesPane = lazy(() =>
  import("@/components/Notes/NotesPane").then((m) => ({ default: m.NotesPane }))
);
const LazyDevPreviewPane = lazy(() =>
  import("@/components/DevPreview/DevPreviewPane").then((m) => ({ default: m.DevPreviewPane }))
);

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
function NotesPaneWrapper(props: any) {
  return (
    <ErrorBoundary variant="component" componentName="NotesPane">
      <Suspense fallback={<NotesPaneSkeleton />}>
        <LazyNotesPane {...props} />
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

const BUILT_IN_SERIALIZE_DEFAULTS: Record<
  string,
  {
    serialize: NonNullable<PanelKindConfig["serialize"]>;
    createDefaults: NonNullable<PanelKindConfig["createDefaults"]>;
  }
> = {
  terminal: { serialize: serializePtyPanel, createDefaults: createTerminalDefaults },
  agent: { serialize: serializeAgent, createDefaults: createAgentDefaults },
  browser: { serialize: serializeBrowser, createDefaults: createBrowserDefaults },
  notes: { serialize: serializeNotes, createDefaults: createNotesDefaults },
  "dev-preview": { serialize: serializeDevPreview, createDefaults: createDevPreviewDefaults },
};

export function initBuiltInPanelKinds(): void {
  for (const [kindId, hooks] of Object.entries(BUILT_IN_SERIALIZE_DEFAULTS)) {
    const existing = requirePanelKindConfig(kindId);
    if (
      existing.serialize !== hooks.serialize ||
      existing.createDefaults !== hooks.createDefaults
    ) {
      existing.serialize = hooks.serialize;
      existing.createDefaults = hooks.createDefaults;
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
  agent: { ...requirePanelKindConfig("agent"), component: TerminalPane },
  browser: { ...requirePanelKindConfig("browser"), component: BrowserPaneWrapper },
  notes: { ...requirePanelKindConfig("notes"), component: NotesPaneWrapper },
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
