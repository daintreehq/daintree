/**
 * Built-in panel component registrations.
 * Called once at app startup to register terminal, agent, browser, and notes panels.
 */
import { Suspense, lazy } from "react";
import { registerPanelComponent } from "./panelComponentRegistry";
import { TerminalPane } from "@/components/Terminal/TerminalPane";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BrowserPaneSkeleton } from "@/components/Browser/BrowserPaneSkeleton";
import { NotesPaneSkeleton } from "@/components/Notes/NotesPaneSkeleton";

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

// Registration flag to prevent double registration
let registered = false;

/**
 * Register all built-in panel components.
 * Safe to call multiple times - only registers once.
 */
export function registerBuiltInPanelComponents(): void {
  if (registered) return;
  registered = true;

  registerPanelComponent("terminal", { component: TerminalPane }, { allowOverride: true });
  registerPanelComponent("agent", { component: TerminalPane }, { allowOverride: true });
  registerPanelComponent("browser", { component: BrowserPaneWrapper }, { allowOverride: true });
  registerPanelComponent("notes", { component: NotesPaneWrapper }, { allowOverride: true });
  registerPanelComponent(
    "dev-preview",
    { component: DevPreviewPaneWrapper },
    { allowOverride: true }
  );
}
