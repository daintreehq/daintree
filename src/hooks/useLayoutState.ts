import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useFocusStore,
  useDiagnosticsStore,
  usePortalStore,
  useErrorStore,
  usePerformanceModeStore,
  type PanelState,
  type DiagnosticsTab,
} from "@/store";
export interface LayoutState {
  isFocusMode: boolean;
  toggleFocusMode: (currentState: PanelState) => void;
  setFocusMode: (mode: boolean, savedState?: PanelState) => void;
  savedPanelState: PanelState | null;

  diagnosticsOpen: boolean;
  setDiagnosticsOpen: (open: boolean) => void;
  openDiagnosticsDock: (tab: DiagnosticsTab) => void;

  portalOpen: boolean;
  portalWidth: number;
  togglePortal: () => void;

  performanceMode: boolean;
  errorCount: number;
}

export function useLayoutState(): LayoutState {
  const focusState = useFocusStore(
    useShallow((state) => ({
      isFocusMode: state.isFocusMode,
      toggleFocusMode: state.toggleFocusMode,
      setFocusMode: state.setFocusMode,
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

  const performanceMode = usePerformanceModeStore((state) => state.performanceMode);

  const errorCount = useErrorStore(
    useShallow((state) => state.errors.filter((e) => !e.dismissed).length)
  );

  return useMemo(
    () => ({
      ...focusState,
      ...diagnosticsState,
      ...portalState,
      performanceMode,
      errorCount,
    }),
    [focusState, diagnosticsState, portalState, performanceMode, errorCount]
  );
}
