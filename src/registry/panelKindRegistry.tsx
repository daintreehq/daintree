import { Suspense, lazy, type ComponentType } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { TerminalPane } from "@/components/Terminal/TerminalPane";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BrowserPaneSkeleton } from "@/components/Browser/BrowserPaneSkeleton";
import { NotesPaneSkeleton } from "@/components/Notes/NotesPaneSkeleton";

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

/**
 * Unified panel kind definition combining metadata and component.
 * Extends the shared PanelKindConfig (metadata-only) with a renderer-side component.
 */
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

export function registerPanelKindDefinition(definition: PanelKindDefinition): void {
  if (PANEL_KIND_DEFINITION_REGISTRY[definition.id]) {
    console.warn(`Panel kind definition "${definition.id}" already registered, overwriting`);
  }
  PANEL_KIND_DEFINITION_REGISTRY[definition.id] = definition;
}
