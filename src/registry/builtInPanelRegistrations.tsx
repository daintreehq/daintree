/**
 * Built-in panel component registrations.
 * Called once at app startup to register terminal, agent, browser, and notes panels.
 */
import { Suspense, lazy } from "react";
import { Loader2 } from "lucide-react";
import { registerPanelComponent } from "./panelComponentRegistry";
import { TerminalPane } from "@/components/Terminal/TerminalPane";

const LazyBrowserPane = lazy(() =>
  import("@/components/Browser/BrowserPane").then((m) => ({ default: m.BrowserPane }))
);
const LazyNotesPane = lazy(() =>
  import("@/components/Notes/NotesPane").then((m) => ({ default: m.NotesPane }))
);
const LazyDevPreviewPane = lazy(() =>
  import("@/components/DevPreview/DevPreviewPane").then((m) => ({ default: m.DevPreviewPane }))
);

function PanelLoadingFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-canopy-text/30" />
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function BrowserPaneWrapper(props: any) {
  return (
    <Suspense fallback={<PanelLoadingFallback />}>
      <LazyBrowserPane {...props} />
    </Suspense>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function NotesPaneWrapper(props: any) {
  return (
    <Suspense fallback={<PanelLoadingFallback />}>
      <LazyNotesPane {...props} />
    </Suspense>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DevPreviewPaneWrapper(props: any) {
  return (
    <Suspense fallback={<PanelLoadingFallback />}>
      <LazyDevPreviewPane {...props} />
    </Suspense>
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
