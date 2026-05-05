import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useFocusStore,
  useDiagnosticsStore,
  usePortalStore,
  useHelpPanelStore,
  useErrorStore,
  usePerformanceModeStore,
  type PanelState,
  type DiagnosticsTab,
} from "@/store";
export interface LayoutState {
  isFocusMode: boolean;
  gestureSidebarHidden: boolean;
  gestureAssistantHidden: boolean;
  toggleFocusMode: (
    currentState: PanelState,
    visibility?: { sidebarVisible: boolean; assistantVisible: boolean }
  ) => void;
  setFocusMode: (mode: boolean, savedState?: PanelState) => void;
  setSidebarGestureHidden: (hidden: boolean, currentPanelState?: PanelState) => void;
  clearSidebarGesture: () => void;
  clearAssistantGesture: () => void;
  savedPanelState: PanelState | null;

  diagnosticsOpen: boolean;
  setDiagnosticsOpen: (open: boolean) => void;
  openDiagnosticsDock: (tab: DiagnosticsTab) => void;

  portalOpen: boolean;
  portalWidth: number;
  togglePortal: () => void;

  helpPanelOpen: boolean;
  helpPanelWidth: number;
  toggleHelpPanel: () => void;

  performanceMode: boolean;
  errorCount: number;
}

export function useLayoutState(): LayoutState {
  const focusState = useFocusStore(
    useShallow((state) => ({
      isFocusMode: state.isFocusMode,
      gestureSidebarHidden: state.gestureSidebarHidden,
      gestureAssistantHidden: state.gestureAssistantHidden,
      toggleFocusMode: state.toggleFocusMode,
      setFocusMode: state.setFocusMode,
      setSidebarGestureHidden: state.setSidebarGestureHidden,
      clearSidebarGesture: state.clearSidebarGesture,
      clearAssistantGesture: state.clearAssistantGesture,
      savedPanelState: state.savedPanelState,
    }))
  );

  const diagnosticsState = useDiagnosticsStore(
    useShallow((state) => ({
      diagnosticsOpen: state.isOpen,
      setDiagnosticsOpen: state.setOpen,
      openDiagnosticsDock: state.openDock,
    }))
  );

  const portalState = usePortalStore(
    useShallow((state) => ({
      portalOpen: state.isOpen,
      portalWidth: state.width,
      togglePortal: state.toggle,
    }))
  );

  const helpPanelState = useHelpPanelStore(
    useShallow((state) => ({
      helpPanelOpen: state.isOpen,
      helpPanelWidth: state.width,
      toggleHelpPanel: state.toggle,
    }))
  );

  const performanceMode = usePerformanceModeStore((state) => state.performanceMode);

  const errorCount = useErrorStore((state) => state.errors.filter((e) => !e.dismissed).length);

  return useMemo(
    () => ({
      ...focusState,
      ...diagnosticsState,
      ...portalState,
      ...helpPanelState,
      performanceMode,
      errorCount,
    }),
    [focusState, diagnosticsState, portalState, helpPanelState, performanceMode, errorCount]
  );
}
