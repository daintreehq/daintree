import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useFocusStore,
  useDiagnosticsStore,
  useSidecarStore,
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

  sidecarOpen: boolean;
  sidecarWidth: number;
  toggleSidecar: () => void;

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

  const sidecarState = useSidecarStore(
    useShallow((state) => ({
      sidecarOpen: state.isOpen,
      sidecarWidth: state.width,
      toggleSidecar: state.toggle,
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
      ...sidecarState,
      performanceMode,
      errorCount,
    }),
    [focusState, diagnosticsState, sidecarState, performanceMode, errorCount]
  );
}
