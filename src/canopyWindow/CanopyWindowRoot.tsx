import { useEffect } from "react";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import { CanopyView } from "@/components/Canopy/CanopyView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { installHostProjectsLoader } from "@/components/Hosts/installHostProjectsLoader";
import { VoiceRecordingAnnouncer } from "@/components/Terminal/VoiceRecordingAnnouncer";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCanopySnapshotSync } from "@/hooks/app/useCanopySnapshotSync";
import { useAppThemeConfig } from "@/hooks/useAppThemeConfig";
import { useTerminalConfig } from "@/hooks/useTerminalConfig";
import { keybindingService } from "@/services/KeybindingService";
import { initKeybindingOverridesSync } from "@/services/keybindingOverridesSync";
import { initTerminalConfigSync } from "@/services/terminalConfigSync";
import { setupFleetSnapshotListeners } from "@/store/fleetSnapshotStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { CANOPY_WINDOW_FRAME } from "./canopyWindowFrame";
import { CanopyPluginSupport } from "./CanopyPluginSupport";
import { startCanopyWindowDictation } from "./canopyWindowDictation";
import { receiveCanopyPopOuts } from "./canopyWindowPopOut";

/**
 * The Canopy window's whole renderer: the inbox and only what it reads, with
 * none of the project shell. Everything started here stops with it, so a hot
 * reload or StrictMode's second mount leaves one of each.
 */
export function CanopyWindowRoot() {
  useAppThemeConfig();
  useTerminalConfig();
  useCanopySnapshotSync();
  const offersPluginViews = usePluginHostedViewsStore(
    (state) => state.views?.some((view) => view.location === "canopy") ?? false
  );
  useEffect(() => {
    const stops = [
      initTerminalConfigSync(),
      initKeybindingOverridesSync(),
      setupFleetSnapshotListeners(),
      installHostProjectsLoader(),
      receiveCanopyPopOuts(),
      startCanopyWindowDictation(),
    ];
    // Project and scratch names label the rows; both stores follow their own pushes.
    safeFireAndForget(useProjectStore.getState().loadProjects(), {
      context: "Reading the projects Canopy lists",
    });
    safeFireAndForget(useScratchStore.getState().loadScratches(), {
      context: "Reading the scratches Canopy lists",
    });
    safeFireAndForget(keybindingService.loadOverrides(), {
      context: "Reading the shortcuts Canopy shows",
    });
    // Its toasts keep the quiet hours and off switch the user set.
    safeFireAndForget(useNotificationSettingsStore.getState().hydrate(), {
      context: "Reading the notification settings",
    });
    return () => {
      for (const stop of stops) stop();
    };
  }, []);
  return (
    <TooltipProvider>
      <div className="h-screen w-screen overflow-hidden bg-surface-dialog">
        <ErrorBoundary variant="fullscreen" componentName="CanopyWindow">
          <CanopyView frame={CANOPY_WINDOW_FRAME} />
        </ErrorBoundary>
      </div>
      <Toaster standalone />
      <AccessibilityAnnouncer />
      {/* Why the dictation key started nothing, or what it did, is said here. */}
      <VoiceRecordingAnnouncer />
      {offersPluginViews && <CanopyPluginSupport />}
    </TooltipProvider>
  );
}
