import { Suspense, lazy, type ComponentProps, type ComponentType } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type {
  PtyPanelData,
  BrowserPanelData,
  DevPreviewPanelData,
  ReviewPanelData,
  FilePanelData,
  FileBrowserPanelData,
  DiffPanelData,
} from "@shared/types/panel";
import { isBuiltInPanelKind, type BuiltInPanelKind } from "@shared/types/panel";
import type {
  TerminalPanelOptions,
  BrowserPanelOptions,
  DevPreviewPanelOptions,
  ReviewPanelOptions,
  FilePanelOptions,
  FileBrowserPanelOptions,
  DiffPanelOptions,
} from "@shared/types/addPanelOptions";
import type { PanelSnapshot } from "@shared/types/project";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BrowserPaneSkeleton } from "@/components/Browser/BrowserPaneSkeleton";
import { ContentFadeIn } from "@/components/ui/ContentFadeIn";
import { TerminalPane } from "@/components/Terminal/TerminalPane";
import { logError } from "@/utils/logger";

import { serializePtyPanel } from "./terminal/serializer";
import { createTerminalDefaults } from "./terminal/defaults";
import { serializeBrowser } from "./browser/serializer";
import { createBrowserDefaults } from "./browser/defaults";
import { serializeDevPreview } from "./dev-preview/serializer";
import { createDevPreviewDefaults } from "./dev-preview/defaults";
import { DevPreviewPaneFallback } from "./dev-preview/DevPreviewPaneFallback";
import { serializeReview } from "./review/serializer";
import { createReviewDefaults } from "./review/defaults";
import { ReviewPaneSkeleton } from "./review/ReviewPaneSkeleton";
import { serializeFile } from "./file/serializer";
import { createFileDefaults } from "./file/defaults";
import { serializeDiff } from "./diff/serializer";
import { createDiffDefaults } from "./diff/defaults";
import { serializeFileBrowser } from "./file-browser/serializer";
import { createFileBrowserDefaults } from "./file-browser/defaults";

export interface PanelComponentProps {
  id: string;
  title: string;
  isFocused: boolean;
  isMaximized?: boolean;
  /**
   * Which presentation is rendering this panel. `"dialog"` means it is hosted
   * inside a modal by `PanelDialogHost`, which supplies the surrounding chrome.
   */
  location?: "grid" | "dock" | "dialog";
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
  showRestoreControl?: boolean;
  isMultiPanelGrid?: boolean;
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
const LazyReviewPane = lazy(() =>
  import("./review/ReviewPane").then((m) => ({ default: m.ReviewPane }))
);
const LazyFilePane = lazy(() => import("./file/FilePane").then((m) => ({ default: m.FilePane })));
const LazyDiffPane = lazy(() => import("./diff/DiffPane").then((m) => ({ default: m.DiffPane })));
const LazyFileBrowserPane = lazy(() =>
  import("./file-browser/FileBrowserPane").then((m) => ({ default: m.FileBrowserPane }))
);

// Wrapper providing Suspense fallback for the lazy dynamic import and
// correct componentName attribution on chunk-load failures. The per-panel
// boundary in GridPanel catches render errors; this wrapper catches import
// failures with proper attribution — the two boundaries serve different roles.
// TerminalPane is intentionally NOT lazy/wrapped: it is the hottest panel kind,
// open/close must feel instant, and a Suspense skeleton + 150ms fade on every
// mount is a visible regression for a live text surface.
// The fade wrapper is a real div, so for every lazy kind it — not the pane it
// wraps — is the direct child of whatever hosts the panel. It therefore has to
// carry the same sizing contract the pane roots do: `h-full` for the
// block-level grid wrappers, `flex-1 min-h-0` so it can shrink inside the
// dialog body's flex column instead of growing to fit a long file (#11254).
// Browser/review/file fallbacks mirror their kind's content silhouette and all
// bones pulse immediately — React's ~300ms fallback throttle already serves the
// anti-flicker gate (#9040 note in useDeferredLoading.ts). Dev preview uses the
// real ContentPanel chrome around a quiet canvas so its first-open boundary has
// the same title, controls, border, and radius as the resolved pane.
function BrowserPaneWrapper(props: ComponentProps<typeof LazyBrowserPane>) {
  return (
    <ErrorBoundary variant="component" componentName="BrowserPane">
      <Suspense fallback={<BrowserPaneSkeleton />}>
        <ContentFadeIn className="flex flex-col h-full w-full flex-1 min-h-0">
          <LazyBrowserPane {...props} />
        </ContentFadeIn>
      </Suspense>
    </ErrorBoundary>
  );
}

function DevPreviewPaneWrapper(props: ComponentProps<typeof LazyDevPreviewPane>) {
  return (
    <ErrorBoundary variant="component" componentName="DevPreviewPane">
      <Suspense fallback={<DevPreviewPaneFallback {...props} />}>
        <LazyDevPreviewPane {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

function ReviewPaneWrapper(props: ComponentProps<typeof LazyReviewPane>) {
  return (
    <ErrorBoundary variant="component" componentName="ReviewPane">
      <Suspense fallback={<ReviewPaneSkeleton />}>
        <ContentFadeIn className="flex flex-col h-full w-full flex-1 min-h-0">
          <LazyReviewPane {...props} />
        </ContentFadeIn>
      </Suspense>
    </ErrorBoundary>
  );
}

function FilePaneWrapper(props: ComponentProps<typeof LazyFilePane>) {
  return (
    <ErrorBoundary variant="component" componentName="FilePane">
      <Suspense fallback={<BrowserPaneSkeleton label="Loading file panel" />}>
        <ContentFadeIn className="flex flex-col h-full w-full flex-1 min-h-0">
          <LazyFilePane {...props} />
        </ContentFadeIn>
      </Suspense>
    </ErrorBoundary>
  );
}

function DiffPaneWrapper(props: ComponentProps<typeof LazyDiffPane>) {
  return (
    <ErrorBoundary variant="component" componentName="DiffPane">
      <Suspense fallback={<BrowserPaneSkeleton label="Loading diff panel" />}>
        <ContentFadeIn className="flex flex-col h-full w-full flex-1 min-h-0">
          <LazyDiffPane {...props} />
        </ContentFadeIn>
      </Suspense>
    </ErrorBoundary>
  );
}

function FileBrowserPaneWrapper(props: ComponentProps<typeof LazyFileBrowserPane>) {
  return (
    <ErrorBoundary variant="component" componentName="FileBrowserPane">
      <Suspense fallback={<BrowserPaneSkeleton label="Loading file browser" />}>
        <ContentFadeIn className="flex flex-col h-full w-full flex-1 min-h-0">
          <LazyFileBrowserPane {...props} />
        </ContentFadeIn>
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
  review: ReviewPanelData;
  file: FilePanelData;
  "file-browser": FileBrowserPanelData;
  diff: DiffPanelData;
}

interface BuiltInPanelOptionsMap {
  terminal: TerminalPanelOptions;
  browser: BrowserPanelOptions;
  "dev-preview": DevPreviewPanelOptions;
  review: ReviewPanelOptions;
  file: FilePanelOptions;
  "file-browser": FileBrowserPanelOptions;
  diff: DiffPanelOptions;
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
  review: { serialize: serializeReview, createDefaults: createReviewDefaults },
  file: { serialize: serializeFile, createDefaults: createFileDefaults },
  "file-browser": {
    serialize: serializeFileBrowser,
    createDefaults: createFileBrowserDefaults,
  },
  diff: { serialize: serializeDiff, createDefaults: createDiffDefaults },
} satisfies BuiltInSerializeDefaults;

export function initBuiltInPanelKinds(): void {
  for (const [kindId, hooks] of Object.entries(BUILT_IN_SERIALIZE_DEFAULTS)) {
    const existing = requirePanelKindConfig(kindId);
    // Narrow per-kind hooks widened to PanelKindConfig — property-syntax
    // invariant enforced by @typescript-eslint/method-signature-style.
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

// `Record<string, …>` stays for registerPanelKindDefinition runtime mutation
// (dynamic string keys). `satisfies Record<BuiltInPanelKind, …>` on the
// initializer below catches a missing built-in kind at compile time without
// stripping the index signature from the declared type.
const PANEL_KIND_DEFINITION_REGISTRY: Record<string, PanelKindDefinition> = {
  terminal: { ...requirePanelKindConfig("terminal"), component: TerminalPane },
  browser: { ...requirePanelKindConfig("browser"), component: BrowserPaneWrapper },
  "dev-preview": { ...requirePanelKindConfig("dev-preview"), component: DevPreviewPaneWrapper },
  review: { ...requirePanelKindConfig("review"), component: ReviewPaneWrapper },
  file: { ...requirePanelKindConfig("file"), component: FilePaneWrapper },
  "file-browser": {
    ...requirePanelKindConfig("file-browser"),
    component: FileBrowserPaneWrapper,
  },
  diff: { ...requirePanelKindConfig("diff"), component: DiffPaneWrapper },
} satisfies Record<BuiltInPanelKind, PanelKindDefinition>;

/**
 * Reactive snapshot for `useSyncExternalStore`. Replaced (not mutated) on
 * every registry change so React's `Object.is` identity check schedules a
 * rerender — components observing this snapshot then index into it and pick up
 * newly-registered plugin panels without needing a window reload.
 *
 * Render paths MUST resolve a definition as `definitions[kind]` off the value
 * this hook returns. Subscribing and then calling `getPanelKindDefinition(kind)`
 * separately looks equivalent but is not: React Compiler cannot see that the
 * getter closes over mutable module state, so it caches the call keyed only on
 * `kind` and the panel stays on its placeholder forever (#11636). The getter is
 * for imperative, non-render callers only.
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
      logError("[panelKindRegistry] definition listener threw", err);
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
    if (!component) {
      logError(
        `[panelKindRegistry] registerPanelKindDefinition("${definitionOrKindId}") called without a component`
      );
      return;
    }
    definition = { ...config, component };
  } else {
    definition = definitionOrKindId;
  }

  const existing = PANEL_KIND_DEFINITION_REGISTRY[definition.id];
  if (existing && existing.extensionId === undefined && definition.extensionId !== undefined) {
    logError(
      `[panelKindRegistry] Refusing to overwrite built-in panel kind definition "${definition.id}" with extension "${definition.extensionId}"`
    );
    return;
  }
  if (existing) {
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
 * Built-in kinds (entries with no `extensionId`) are never removable — their
 * components are wired at module load and unregistering would leave panels
 * orphaned with no recovery path. Mirrors the `extensionId === undefined`
 * guard used by `unregisterPanelKind` in the shared registry.
 */
export function unregisterPanelKindDefinition(kindId: string): boolean {
  if (isBuiltInPanelKind(kindId)) {
    return false;
  }
  if (!(kindId in PANEL_KIND_DEFINITION_REGISTRY)) {
    return false;
  }
  delete PANEL_KIND_DEFINITION_REGISTRY[kindId];
  notifyDefinitionListeners();
  return true;
}
