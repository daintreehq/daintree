import { useCallback, useState, useEffect, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store/terminalStore";
import { useErrorStore } from "@/store/errorStore";
import type { AgentState, CopyTreeProgress } from "@/types";
import { copyTreeClient } from "@/clients";
import { DEFAULT_COPYTREE_FORMAT } from "@/lib/copyTreeFormat";

export type InjectionStatus = "idle" | "waiting" | "injecting";

export interface UseContextInjectionReturn {
  inject: (worktreeId: string, terminalId?: string, selectedPaths?: string[]) => Promise<void>;
  cancel: () => void;
  isInjecting: boolean;
  isPendingInjection: boolean;
  injectionStatus: InjectionStatus;
  progress: CopyTreeProgress | null;
  error: string | null;
  clearError: () => void;
}

function isAgentReady(agentState: AgentState | undefined): boolean {
  return agentState === "idle" || agentState === "waiting";
}

// Global shared state for injection tracking with event-based subscription
// All hook instances subscribe to this to coordinate progress display
type InjectionStateListener = () => void;

interface PendingInjection {
  id: number;
  terminalId: string;
  worktreeId: string;
  selectedPaths?: string[];
  resolve: () => void;
  reject: (error: Error) => void;
}

const globalInjectionState = {
  isInjecting: false,
  isPendingInjection: false,
  activeTerminalId: null as string | null,
  lastProgress: null as CopyTreeProgress | null,
  injectionId: 0, // Incremented on each injection to prevent cross-run interference
  activeInjectionUuid: null as string | null, // UUID for per-operation cancellation
  pendingInjection: null as PendingInjection | null,
  listeners: new Set<InjectionStateListener>(),

  snapshot: {
    isInjecting: false,
    isPendingInjection: false,
    activeTerminalId: null as string | null,
    lastProgress: null as CopyTreeProgress | null,
  },

  notify() {
    this.snapshot = {
      isInjecting: this.isInjecting,
      isPendingInjection: this.isPendingInjection,
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

  clearPending() {
    if (this.pendingInjection) {
      this.pendingInjection.reject(new Error("Injection cancelled"));
      this.pendingInjection = null;
      this.isPendingInjection = false;
      this.notify();
    }
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
  const isPendingInjection = globalState.isPendingInjection && isTargetTerminal;

  // Compute injection status for UI feedback
  const injectionStatus: InjectionStatus = isPendingInjection
    ? "waiting"
    : isInjecting
      ? "injecting"
      : "idle";

  // Only show progress for the active terminal
  // Use localProgressRef if available, otherwise fall back to global state for initial messages
  const progress =
    isInjecting || isPendingInjection
      ? (localProgressRef.current ?? globalState.lastProgress)
      : null;

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

  // Subscribe to terminal store to detect agent state changes for pending injections
  useEffect(() => {
    const unsubscribe = useTerminalStore.subscribe((state, prevState) => {
      const pending = globalInjectionState.pendingInjection;
      if (!pending) return;

      const terminal = state.terminals.find((t) => t.id === pending.terminalId);
      const prevTerminal = prevState.terminals.find((t) => t.id === pending.terminalId);

      // Handle terminal deletion while waiting
      if (!terminal && prevTerminal) {
        pending.reject(new Error("Terminal was deleted while waiting for agent"));
        globalInjectionState.pendingInjection = null;
        globalInjectionState.isPendingInjection = false;
        globalInjectionState.activeTerminalId = null;
        globalInjectionState.lastProgress = null;
        globalInjectionState.notify();
        return;
      }

      // Only process if agent state changed to ready
      if (
        terminal &&
        isAgentReady(terminal.agentState) &&
        !isAgentReady(prevTerminal?.agentState)
      ) {
        pending.resolve();
        globalInjectionState.pendingInjection = null;
        globalInjectionState.isPendingInjection = false;
        globalInjectionState.notify();
      }
    });

    return unsubscribe;
  }, []);

  const inject = useCallback(
    async (worktreeId: string, terminalId?: string, selectedPaths?: string[]) => {
      const activeTerminal = terminalId || focusedId;

      if (!activeTerminal) {
        setError("No terminal selected");
        return;
      }

      // Block concurrent injections to prevent state corruption
      if (globalInjectionState.isInjecting || globalInjectionState.isPendingInjection) {
        setError("Another injection is already in progress. Please wait or cancel it first.");
        return;
      }

      let terminal = terminals.find((t: TerminalInstance) => t.id === activeTerminal);
      if (!terminal) {
        setError(`Terminal not found: ${activeTerminal}`);
        return;
      }

      // Clear any previous error
      setError(null);

      // Generate a new injection ID early to track this specific injection
      globalInjectionState.injectionId++;
      const currentInjectionId = globalInjectionState.injectionId;

      // Gate injection for agent terminals that are not ready
      // Non-agent terminals (agentState undefined) inject immediately
      if (terminal.agentId && !isAgentReady(terminal.agentState)) {
        console.log(
          `Agent is not ready (state: ${terminal.agentState}), waiting for idle/waiting state`
        );

        // Cancel any existing pending injection (regardless of terminal)
        // to prevent promise leaks
        if (globalInjectionState.pendingInjection) {
          globalInjectionState.clearPending();
        }

        // Set up pending injection state
        globalInjectionState.isPendingInjection = true;
        globalInjectionState.activeTerminalId = activeTerminal;
        globalInjectionState.lastProgress = {
          stage: "Waiting",
          progress: 0,
          message: "Waiting for agent to become idle...",
        };
        localProgressRef.current = globalInjectionState.lastProgress;
        globalInjectionState.notify();

        // Wait for agent to become idle
        try {
          await new Promise<void>((resolve, reject) => {
            globalInjectionState.pendingInjection = {
              id: currentInjectionId,
              terminalId: activeTerminal,
              worktreeId,
              selectedPaths,
              resolve,
              reject,
            };

            // Immediately re-check if agent became ready between initial check and pending setup
            const currentTerminal = useTerminalStore
              .getState()
              .terminals.find((t) => t.id === activeTerminal);
            if (currentTerminal && isAgentReady(currentTerminal.agentState)) {
              resolve();
              globalInjectionState.pendingInjection = null;
              globalInjectionState.isPendingInjection = false;
            }
          });
        } catch (e) {
          // Injection was cancelled while waiting
          const message = e instanceof Error ? e.message : "Injection cancelled";
          if (message !== "Injection cancelled") {
            setError(message);
          }
          // Clear stale progress on early abort
          localProgressRef.current = null;
          return;
        }

        // Re-fetch terminal state after waiting (it may have changed)
        const updatedTerminal = useTerminalStore
          .getState()
          .terminals.find((t) => t.id === activeTerminal);
        if (!updatedTerminal) {
          setError(`Terminal no longer exists: ${activeTerminal}`);
          return;
        }

        // Verify agent is still ready (could have changed during race)
        if (updatedTerminal.agentId && !isAgentReady(updatedTerminal.agentState)) {
          console.log(
            `Agent state changed to ${updatedTerminal.agentState} while waiting, aborting injection`
          );
          setError("Agent became busy again, injection aborted");
          // Clear stale progress on early abort
          localProgressRef.current = null;
          return;
        }

        // Use updatedTerminal for subsequent operations (not the stale terminal reference)
        terminal = updatedTerminal;

        console.log("Agent is now idle, proceeding with context injection");
      }

      // Generate a unique ID for this injection operation (for per-operation cancellation)
      const injectionUuid = crypto.randomUUID();

      // Set global state so all hook instances can see the active injection
      globalInjectionState.isInjecting = true;
      globalInjectionState.activeTerminalId = activeTerminal;
      globalInjectionState.activeInjectionUuid = injectionUuid;
      globalInjectionState.lastProgress = {
        stage: "Starting",
        progress: 0,
        message: "Initializing...",
      };
      globalInjectionState.isPendingInjection = false;
      globalInjectionState.notify();

      try {
        const isAvailable = await copyTreeClient.isAvailable();
        if (!isAvailable) {
          throw new Error(
            "CopyTree CLI not installed. Please install copytree to use this feature."
          );
        }

        const options = {
          format: DEFAULT_COPYTREE_FORMAT,
          ...(selectedPaths && selectedPaths.length > 0 ? { includePaths: selectedPaths } : {}),
        };

        const result = await copyTreeClient.injectToTerminal(
          activeTerminal,
          worktreeId,
          options,
          injectionUuid
        );

        if (result.error) {
          throw new Error(result.error);
        }

        const pathInfo =
          selectedPaths && selectedPaths.length > 0
            ? ` from ${selectedPaths.length} selected ${selectedPaths.length === 1 ? "path" : "paths"}`
            : "";
        console.log(
          `Context injected (${result.fileCount} files as ${DEFAULT_COPYTREE_FORMAT.toUpperCase()}${pathInfo})`
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
        });

        currentErrorIdRef.current = errorId;

        console.error("Context injection failed:", message);
      } finally {
        // Only clear global state if we own this injection (prevent cross-run interference)
        if (globalInjectionState.injectionId === currentInjectionId) {
          globalInjectionState.isInjecting = false;
          globalInjectionState.activeTerminalId = null;
          globalInjectionState.activeInjectionUuid = null;
          globalInjectionState.lastProgress = null;
          localProgressRef.current = null;
          globalInjectionState.notify();
        }
      }
    },
    [focusedId, terminals, addError, removeError]
  );

  const cancel = useCallback(() => {
    // Cancel pending injection if waiting
    globalInjectionState.clearPending();

    // Cancel only the current active injection (not all CopyTree operations)
    const injectionUuid = globalInjectionState.activeInjectionUuid;
    if (injectionUuid) {
      copyTreeClient.cancel(injectionUuid).catch(console.error);
    }

    globalInjectionState.isInjecting = false;
    globalInjectionState.isPendingInjection = false;
    globalInjectionState.activeTerminalId = null;
    globalInjectionState.activeInjectionUuid = null;
    globalInjectionState.lastProgress = null;
    localProgressRef.current = null;
    globalInjectionState.notify();
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    inject,
    cancel,
    isInjecting,
    isPendingInjection,
    injectionStatus,
    progress,
    error,
    clearError,
  };
}
