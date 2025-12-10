import { useCallback, useState, useEffect, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store/terminalStore";
import { useErrorStore } from "@/store/errorStore";
import type { TerminalType } from "@/components/Terminal/TerminalPane";
import type { AgentState } from "@/types";
import { copyTreeClient } from "@/clients";

type CopyTreeFormat = "xml" | "json" | "markdown" | "tree" | "ndjson";

// Different AI agents have different preferences for context format
const AGENT_FORMAT_MAP: Record<TerminalType, CopyTreeFormat> = {
  claude: "xml",
  gemini: "markdown",
  codex: "xml",
  terminal: "xml",
};

function getOptimalFormat(terminalType: TerminalType): CopyTreeFormat {
  const format = AGENT_FORMAT_MAP[terminalType];
  if (!format) {
    console.warn(`Unknown terminal type "${terminalType}", defaulting to XML format`);
    return "xml";
  }
  return format;
}

export interface CopyTreeProgress {
  stage: string;
  progress: number;
  message: string;
  filesProcessed?: number;
  totalFiles?: number;
  currentFile?: string;
}

export interface UseContextInjectionReturn {
  inject: (worktreeId: string, terminalId?: string, selectedPaths?: string[]) => Promise<void>;
  cancel: () => void;
  isInjecting: boolean;
  progress: CopyTreeProgress | null;
  error: string | null;
  clearError: () => void;
}

function isAgentBusy(agentState: AgentState | undefined): boolean {
  return agentState === "working";
}

// Global shared state for injection tracking with event-based subscription
// All hook instances subscribe to this to coordinate progress display
type InjectionStateListener = () => void;

const globalInjectionState = {
  isInjecting: false,
  activeTerminalId: null as string | null,
  lastProgress: null as CopyTreeProgress | null,
  injectionId: 0, // Incremented on each injection to prevent cross-run interference
  listeners: new Set<InjectionStateListener>(),

  snapshot: {
    isInjecting: false,
    activeTerminalId: null as string | null,
    lastProgress: null as CopyTreeProgress | null,
  },

  notify() {
    this.snapshot = {
      isInjecting: this.isInjecting,
      activeTerminalId: this.activeTerminalId,
      lastProgress: this.lastProgress,
    };
    this.listeners.forEach((listener) => listener());
  },

  getSnapshot() {
    return this.snapshot;
  },

  subscribe(listener: InjectionStateListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
};

export function useContextInjection(targetTerminalId?: string): UseContextInjectionReturn {
  const [error, setError] = useState<string | null>(null);
  const focusedId = useTerminalStore((state) => state.focusedId);
  const terminals = useTerminalStore(useShallow((state) => state.terminals));
  const addError = useErrorStore((state) => state.addError);
  const removeError = useErrorStore((state) => state.removeError);

  const lastProgressAtRef = useRef(0);
  const currentErrorIdRef = useRef<string | null>(null);
  const localProgressRef = useRef<CopyTreeProgress | null>(null);

  // Subscribe to global injection state using useSyncExternalStore
  const globalState = useSyncExternalStore(
    globalInjectionState.subscribe.bind(globalInjectionState),
    globalInjectionState.getSnapshot.bind(globalInjectionState)
  );

  // Determine if this terminal is the injection target
  const isTargetTerminal = targetTerminalId === globalState.activeTerminalId;
  const isInjecting = globalState.isInjecting && isTargetTerminal;

  // Only show progress for the active terminal
  const progress = isInjecting ? localProgressRef.current : null;

  // Subscribe to global injection progress and filter for this terminal
  useEffect(() => {
    const unsubscribe = copyTreeClient.onProgress((p) => {
      if (!globalInjectionState.isInjecting) return;

      globalInjectionState.lastProgress = p;

      // Filter: Only update local state if this terminal is the injection target
      if (targetTerminalId && globalInjectionState.activeTerminalId !== targetTerminalId) {
        return;
      }

      // Throttle to 100ms to prevent excessive re-renders
      const now = performance.now();
      if (now - lastProgressAtRef.current < 100) return;
      lastProgressAtRef.current = now;

      localProgressRef.current = p;
      globalInjectionState.notify(); // Trigger re-render
    });
    return unsubscribe;
  }, [targetTerminalId]);

  useEffect(() => {
    return () => {
      currentErrorIdRef.current = null;
    };
  }, []);

  const inject = useCallback(
    async (worktreeId: string, terminalId?: string, selectedPaths?: string[]) => {
      const activeTerminal = terminalId || focusedId;

      if (!activeTerminal) {
        setError("No terminal selected");
        return;
      }

      const terminal = terminals.find((t: TerminalInstance) => t.id === activeTerminal);
      if (!terminal) {
        setError(`Terminal not found: ${activeTerminal}`);
        return;
      }

      // Warn but proceed - agent might finish by the time context is generated
      if (isAgentBusy(terminal.agentState)) {
        console.log("Agent is busy, context will be injected when generation completes");
      }

      // Set global state so all hook instances can see the active injection
      globalInjectionState.injectionId++;
      const currentInjectionId = globalInjectionState.injectionId;
      globalInjectionState.isInjecting = true;
      globalInjectionState.activeTerminalId = activeTerminal;
      globalInjectionState.lastProgress = {
        stage: "Starting",
        progress: 0,
        message: "Initializing...",
      };
      globalInjectionState.notify();

      setError(null);

      try {
        const isAvailable = await copyTreeClient.isAvailable();
        if (!isAvailable) {
          throw new Error(
            "CopyTree CLI not installed. Please install copytree to use this feature."
          );
        }

        const format = getOptimalFormat(terminal.type);

        const options = {
          format,
          ...(selectedPaths && selectedPaths.length > 0 ? { includePaths: selectedPaths } : {}),
        };

        const result = await copyTreeClient.injectToTerminal(activeTerminal, worktreeId, options);

        if (result.error) {
          throw new Error(result.error);
        }

        const pathInfo =
          selectedPaths && selectedPaths.length > 0
            ? ` from ${selectedPaths.length} selected ${selectedPaths.length === 1 ? "path" : "paths"}`
            : "";
        console.log(
          `Context injected (${result.fileCount} files as ${format.toUpperCase()}${pathInfo})`
        );

        if (currentErrorIdRef.current) {
          removeError(currentErrorIdRef.current);
          currentErrorIdRef.current = null;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to inject context";
        const details = e instanceof Error ? e.stack : undefined;

        setError(message);

        let errorType: "config" | "process" | "filesystem" = "process";
        if (message.includes("not installed") || message.includes("not found")) {
          errorType = "config";
        } else if (message.includes("permission") || message.includes("EACCES")) {
          errorType = "filesystem";
        }

        const errorId = addError({
          type: errorType,
          message: `Context injection failed: ${message}`,
          details,
          source: "ContextInjection",
          context: {
            worktreeId,
            terminalId: activeTerminal,
          },
          isTransient: true,
          retryAction: "injectContext",
          retryArgs: {
            worktreeId,
            terminalId: activeTerminal,
            selectedPaths,
          },
        });

        currentErrorIdRef.current = errorId;

        console.error("Context injection failed:", message);
      } finally {
        // Only clear global state if we own this injection (prevent cross-run interference)
        if (globalInjectionState.injectionId === currentInjectionId) {
          globalInjectionState.isInjecting = false;
          globalInjectionState.activeTerminalId = null;
          globalInjectionState.lastProgress = null;
          localProgressRef.current = null;
          globalInjectionState.notify();
        }
      }
    },
    [focusedId, terminals, addError, removeError]
  );

  const cancel = useCallback(() => {
    copyTreeClient.cancel().catch(console.error);

    globalInjectionState.isInjecting = false;
    globalInjectionState.activeTerminalId = null;
    globalInjectionState.lastProgress = null;
    localProgressRef.current = null;
    globalInjectionState.notify();
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { inject, cancel, isInjecting, progress, error, clearError };
}
