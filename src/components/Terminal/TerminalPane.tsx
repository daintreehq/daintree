import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, Loader2 } from "lucide-react";
import type {
  TerminalType,
  TerminalRestartError,
  SpawnError,
  TerminalReconnectError,
} from "@/types";
import { cn } from "@/lib/utils";
import { XtermAdapter } from "./XtermAdapter";
import { ArtifactOverlay } from "./ArtifactOverlay";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { TerminalRestartBanner } from "./TerminalRestartBanner";
import { TerminalErrorBanner } from "./TerminalErrorBanner";
import { SpawnErrorBanner } from "./SpawnErrorBanner";
import { ReconnectErrorBanner } from "./ReconnectErrorBanner";
import { GeminiAlternateBufferBanner } from "./GeminiAlternateBufferBanner";
import { UpdateCwdDialog } from "./UpdateCwdDialog";
import { ErrorBanner } from "../Errors/ErrorBanner";
import { ContentPanel } from "@/components/Panel";
import { useIsDragging } from "@/components/DragDrop";
import {
  useErrorStore,
  useTerminalStore,
  getTerminalRefreshTier,
  useTerminalInputStore,
} from "@/store";
import { useTerminalLogic } from "@/hooks/useTerminalLogic";
import type { AgentState } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { actionService } from "@/services/ActionService";
import { InputTracker } from "@/services/clearCommandDetection";
import { getAgentConfig } from "@/config/agents";
import { terminalClient } from "@/clients";
import { HybridInputBar, type HybridInputBarHandle } from "./HybridInputBar";
import { getTerminalFocusTarget } from "./terminalFocus";
import { getCanopyCommand, isEscapedCommand, unescapeCommand } from "./canopySlashCommands";

export type { TerminalType };

export interface ActivityState {
  headline: string;
  status: "working" | "waiting" | "success" | "failure";
  type: "interactive" | "background" | "idle";
}

export interface TerminalPaneProps {
  id: string;
  title: string;
  type?: TerminalType;
  agentId?: string;
  worktreeId?: string;
  cwd: string;
  isFocused: boolean;
  isMaximized?: boolean;
  agentState?: AgentState;
  activity?: ActivityState | null;
  lastCommand?: string;
  flowStatus?: "running" | "paused-backpressure" | "paused-user" | "suspended";
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
  location?: "grid" | "dock";
  restartKey?: number;
  isTrashing?: boolean;
  restartError?: TerminalRestartError;
  reconnectError?: TerminalReconnectError;
  spawnError?: SpawnError;
  gridPanelCount?: number;
  detectedProcessId?: string;
  // Tab support
  tabs?: import("@/components/Panel/TabButton").TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

function TerminalPaneComponent({
  id,
  title,
  type,
  agentId,
  worktreeId,
  cwd,
  isFocused,
  isMaximized,
  agentState,
  activity,
  lastCommand,
  flowStatus,
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  location = "grid",
  restartKey = 0,
  isTrashing = false,
  restartError,
  reconnectError,
  spawnError,
  gridPanelCount,
  detectedProcessId,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevFocusedRef = useRef(isFocused);
  const justFocusedUntilRef = useRef<number>(0);
  const inputBarRef = useRef<HybridInputBarHandle>(null);
  const [dismissedRestartPrompt, setDismissedRestartPrompt] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isUpdateCwdOpen, setIsUpdateCwdOpen] = useState(false);
  const [showGeminiBanner, setShowGeminiBanner] = useState(false);
  const [isAutoRestarting, setIsAutoRestarting] = useState(false);
  const autoRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRestartAttemptRef = useRef(0);
  const processStartTimeRef = useRef<number>(0);

  if (isFocused && !prevFocusedRef.current) {
    justFocusedUntilRef.current = performance.now() + 250;
  }

  useEffect(() => {
    prevFocusedRef.current = isFocused;
  }, [isFocused]);

  // Cancel pending auto-restart timer on unmount
  useEffect(() => {
    return () => {
      if (autoRestartTimerRef.current !== null) {
        clearTimeout(autoRestartTimerRef.current);
        autoRestartTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setDismissedRestartPrompt(false);
    inputTrackerRef.current?.reset();
    // Track process start time on each restart for backoff stability window
    processStartTimeRef.current = Date.now();
  }, [restartKey]);

  useEffect(() => {
    let isActive = true;

    if (type !== "gemini") {
      setShowGeminiBanner(false);
      return;
    }

    const dismissed = localStorage.getItem("gemini-alt-buffer-dismissed");
    if (dismissed === "true") {
      setShowGeminiBanner(false);
      return;
    }

    window.electron.gemini
      .getStatus()
      .then((status) => {
        if (!isActive) return;
        if (status.exists && !status.alternateBufferEnabled && !status.error) {
          setShowGeminiBanner(true);
        } else {
          setShowGeminiBanner(false);
        }
      })
      .catch(() => {
        if (!isActive) return;
        setShowGeminiBanner(false);
      });

    return () => {
      isActive = false;
    };
  }, [type, restartKey]);

  const updateVisibility = useTerminalStore((state) => state.updateVisibility);
  const getTerminal = useTerminalStore((state) => state.getTerminal);
  const restartTerminal = useTerminalStore((state) => state.restartTerminal);
  const trashTerminal = useTerminalStore((state) => state.trashTerminal);
  const setFocused = useTerminalStore((state) => state.setFocused);
  const updateLastCommand = useTerminalStore((state) => state.updateLastCommand);
  const backendStatus = useTerminalStore((state) => state.backendStatus);
  const lastCrashType = useTerminalStore((state) => state.lastCrashType);
  const clearReconnectError = useTerminalStore((state) => state.clearReconnectError);

  // Consolidate terminal state selectors to avoid multiple scans and ensure consistent snapshots
  const terminalState = useTerminalStore(
    useShallow((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      return {
        isInputLocked: terminal?.isInputLocked ?? false,
        stateChangeTrigger: terminal?.stateChangeTrigger,
        isRestarting: terminal?.isRestarting ?? false,
        exitBehavior: terminal?.exitBehavior,
        isTrashedOrRemoved: terminal?.location === "trash" || terminal === undefined,
      };
    })
  );

  const { isInputLocked, stateChangeTrigger, isRestarting, exitBehavior, isTrashedOrRemoved } =
    terminalState;

  const isBackendDisconnected = backendStatus === "disconnected";
  const isBackendRecovering = backendStatus === "recovering";
  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((state) => state.hybridInputAutoFocus);
  const effectiveAgentId =
    agentId === "claude" || agentId === "gemini" || agentId === "codex" || agentId === "opencode"
      ? agentId
      : type === "claude" || type === "gemini" || type === "codex" || type === "opencode"
        ? type
        : undefined;
  const isAgentTerminal = effectiveAgentId !== undefined;
  const showHybridInputBar = isAgentTerminal && hybridInputEnabled;

  const queueCount = useTerminalStore(
    useShallow((state) => state.commandQueue.filter((c) => c.terminalId === id).length)
  );

  const pingedIdSelector = useMemo(
    () => (state: ReturnType<typeof useTerminalStore.getState>) => state.pingedId === id,
    [id]
  );
  const isPinged = useTerminalStore(pingedIdSelector);
  const wasJustSelected = isPinged && isFocused && performance.now() < justFocusedUntilRef.current;

  const terminalErrors = useErrorStore(
    useShallow((state) => state.errors.filter((e) => e.context?.terminalId === id && !e.dismissed))
  );
  const dismissError = useErrorStore((state) => state.dismissError);
  const removeError = useErrorStore((state) => state.removeError);

  const { isExited, exitCode, handleExit, handleErrorRetry } = useTerminalLogic({
    id,
    removeError,
    restartKey,
  });

  // Cancel auto-restart if terminal is intentionally trashed/removed
  useEffect(() => {
    if (isTrashedOrRemoved && autoRestartTimerRef.current !== null) {
      clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
      setIsAutoRestarting(false);
    }
  }, [isTrashedOrRemoved]);

  // Auto-restart logic: when exitBehavior === "restart" and terminal exits (any code except 130)
  useEffect(() => {
    if (!isExited) return;
    if (exitBehavior !== "restart") return;
    if (exitCode === 130) return;
    if (isTrashedOrRemoved) return;
    if (isRestarting) return;

    if (autoRestartTimerRef.current !== null) {
      clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
    }

    // Reset backoff if process ran stably for > 10s
    const runDuration =
      processStartTimeRef.current > 0 ? Date.now() - processStartTimeRef.current : 0;
    if (runDuration > 10_000) {
      autoRestartAttemptRef.current = 0;
    }

    const attempt = autoRestartAttemptRef.current;
    // Exponential backoff: 250ms, 500ms, 1s, 2s, 4s, capped at 5s
    const delay = Math.min(250 * Math.pow(2, attempt), 5_000);
    autoRestartAttemptRef.current = attempt + 1;

    setIsAutoRestarting(true);

    autoRestartTimerRef.current = setTimeout(() => {
      autoRestartTimerRef.current = null;
      const currentTerminal = useTerminalStore.getState().terminals.find((t) => t.id === id);
      if (!currentTerminal || currentTerminal.location === "trash") {
        setIsAutoRestarting(false);
        return;
      }
      restartTerminal(id);
      setIsAutoRestarting(false);
    }, delay);

    return () => {
      if (autoRestartTimerRef.current !== null) {
        clearTimeout(autoRestartTimerRef.current);
        autoRestartTimerRef.current = null;
        setIsAutoRestarting(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExited, exitBehavior, exitCode, isTrashedOrRemoved]);

  // Track drag state in a ref to avoid useEffect cleanup timing issues.
  // If isDragging is in the dependency array, cleanup runs on drag START
  // with the OLD isDragging=false value, which would set visibility to false!
  const isDragging = useIsDragging();
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  // Visibility observation - stable observer, ref-gated callback
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Don't update visibility during drag - CSS transforms cause false negatives
        if (isDraggingRef.current) return;

        updateVisibility(id, entry.isIntersecting);
        terminalInstanceService.setVisible(id, entry.isIntersecting);
      },
      {
        threshold: 0.1,
      }
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [id, updateVisibility]);

  // Separate unmount cleanup - only runs on actual unmount, not on drag changes
  useEffect(() => {
    return () => {
      updateVisibility(id, false);
      terminalInstanceService.setVisible(id, false);
    };
  }, [id, updateVisibility]);

  const handleReady = useCallback(() => {}, []);

  const inputTrackerRef = useRef<InputTracker | null>(null);

  if (!inputTrackerRef.current) {
    inputTrackerRef.current = new InputTracker();
  }

  const handleInput = useCallback(
    (data: string) => {
      const tracker = inputTrackerRef.current;
      if (!tracker) return;

      const results = tracker.process(data);

      for (const result of results) {
        if (result.isClear) {
          const managed = terminalInstanceService.get(id);
          if (managed?.terminal) {
            try {
              managed.terminal.clear();
            } catch (error) {
              console.warn(`Failed to clear terminal ${id}:`, error);
            }
          }
        }

        if (result.command) {
          updateLastCommand(id, result.command);
        }
      }
    },
    [id, updateLastCommand]
  );

  useEffect(() => {
    const handleFindInPanel = () => {
      if (!isFocused) return;
      setIsSearchOpen(true);
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>("[data-terminal-search-input]")?.focus();
      });
    };

    window.addEventListener("canopy:find-in-panel", handleFindInPanel);
    return () => window.removeEventListener("canopy:find-in-panel", handleFindInPanel);
  }, [isFocused]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Handle Cmd+C to copy xterm selection regardless of which child has focus.
      // This is needed because agent terminals focus the hybrid input bar, so
      // xterm's built-in copy handler never receives the copy event.
      if (e.metaKey && e.key === "c") {
        const managed = terminalInstanceService.get(id);
        if (managed?.terminal.hasSelection()) {
          const nativeSelection = window.getSelection()?.toString() ?? "";
          if (nativeSelection.length === 0) {
            e.preventDefault();
            void navigator.clipboard.writeText(managed.terminal.getSelection());
            return;
          }
        }
      }

      const target = e.target as HTMLElement;

      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
        return;
      }

      if (target.tagName === "BUTTON" || target !== e.currentTarget) {
        return;
      }

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setFocused(id);
      }
    },
    [id, setFocused]
  );

  const getRefreshTierCallback = useCallback(() => {
    const terminal = getTerminal(id);
    return getTerminalRefreshTier(terminal, isFocused);
  }, [id, isFocused, getTerminal]);

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      const managed = terminalInstanceService.get(id);
      if (managed?.terminal.hasSelection()) {
        // Prevent ContentPanel from calling onFocus() which triggers parent
        // re-renders. Don't call setFocused() either — it triggers a
        // wake+restore cycle that calls terminal.reset(), clearing selection.
        e?.preventDefault();
        return;
      }
      setFocused(id);
      terminalInstanceService.boostRefreshRate(id);
    },
    [id, setFocused]
  );

  const handleXtermPointerDownCapture = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;

      const target = e.target as HTMLElement | null;
      const xtermElement = target?.closest(".xterm");
      if (!xtermElement) return;

      if (xtermElement.classList.contains("xterm-cursor-pointer")) {
        return;
      }

      const focusTarget = getTerminalFocusTarget({
        isAgentTerminal,
        isInputDisabled: isBackendDisconnected || isBackendRecovering,
        hybridInputEnabled,
        hybridInputAutoFocus,
      });

      if (focusTarget !== "hybridInput") return;
      if (isFocused) return;

      e.preventDefault();
      e.stopPropagation();

      setFocused(id);
      terminalInstanceService.boostRefreshRate(id);
      requestAnimationFrame(() => inputBarRef.current?.focusWithCursorAtEnd());
    },
    [
      id,
      isAgentTerminal,
      hybridInputEnabled,
      hybridInputAutoFocus,
      isBackendDisconnected,
      isBackendRecovering,
      isFocused,
      setFocused,
    ]
  );

  const handleRestart = useCallback(() => {
    restartTerminal(id);
    inputTrackerRef.current?.reset();
  }, [restartTerminal, id]);

  const handleUpdateCwd = useCallback(() => {
    setIsUpdateCwdOpen(true);
  }, []);

  const handleTrash = useCallback(() => {
    trashTerminal(id);
  }, [trashTerminal, id]);

  const handleDismissReconnectError = useCallback(() => {
    clearReconnectError(id);
  }, [clearReconnectError, id]);

  useEffect(() => {
    terminalInstanceService.setFocused(id, isFocused);

    if (!isFocused) return;

    const focusTarget = getTerminalFocusTarget({
      isAgentTerminal,
      isInputDisabled: isBackendDisconnected || isBackendRecovering || isInputLocked,
      hybridInputEnabled,
      hybridInputAutoFocus,
    });

    if (focusTarget === "hybridInput") {
      const rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // xterm v6 clears selection on blur. Don't steal focus from
          // xterm when the user has an active text selection.
          const managed = terminalInstanceService.get(id);
          if (managed?.terminal.hasSelection()) return;
          inputBarRef.current?.focusWithCursorAtEnd();
        });
      });
      return () => cancelAnimationFrame(rafId);
    }

    const rafId = requestAnimationFrame(() => terminalInstanceService.focus(id));
    return () => cancelAnimationFrame(rafId);
  }, [
    id,
    isFocused,
    isAgentTerminal,
    hybridInputEnabled,
    hybridInputAutoFocus,
    isBackendDisconnected,
    isBackendRecovering,
    isInputLocked,
  ]);

  // Sync agent state to terminal service for scroll management
  useEffect(() => {
    terminalInstanceService.setAgentState(id, agentState ?? "idle");
  }, [id, agentState]);

  const isWorking = agentState === "working";
  const allowPing = !isMaximized && (location !== "grid" || (gridPanelCount ?? 2) > 1);

  // Determine panel kind based on agent
  const kind = effectiveAgentId ? "agent" : "terminal";

  return (
    <ContentPanel
      ref={containerRef}
      id={id}
      title={title}
      kind={kind}
      type={type}
      agentId={agentId}
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isTrashing={isTrashing}
      gridPanelCount={gridPanelCount}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      onRestart={handleRestart}
      isExited={isExited}
      exitCode={exitCode}
      isWorking={isWorking}
      agentState={agentState}
      activity={activity}
      lastCommand={lastCommand}
      detectedProcessId={detectedProcessId}
      queueCount={queueCount}
      flowStatus={flowStatus}
      isPinged={isPinged}
      wasJustSelected={wasJustSelected}
      tabs={tabs}
      onTabClick={onTabClick}
      onTabClose={onTabClose}
      onTabRename={onTabRename}
      onAddTab={onAddTab}
      className={cn(
        "terminal-pane",
        isExited && "opacity-75 grayscale",
        isPinged &&
          allowPing &&
          (wasJustSelected ? "animate-terminal-ping-select" : "animate-terminal-ping"),
        agentState === "failed" && "ring-1 ring-inset ring-[var(--color-status-error)]/25"
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="group"
      aria-label={(() => {
        if (!effectiveAgentId) {
          return `Terminal: ${title}`;
        }
        const agentConfig = getAgentConfig(effectiveAgentId);
        if (agentConfig) {
          return `${agentConfig.name} agent: ${title}`;
        }
        return `${effectiveAgentId} session: ${title}`;
      })()}
    >
      {terminalErrors.length > 0 && (
        <div className="px-2 py-1 border-b border-canopy-border bg-[color-mix(in_oklab,var(--color-status-error)_5%,transparent)] space-y-1 shrink-0">
          {terminalErrors.slice(0, 2).map((error) => (
            <ErrorBanner
              key={error.id}
              error={error}
              onDismiss={dismissError}
              onRetry={handleErrorRetry}
              compact
            />
          ))}
          {terminalErrors.length > 2 && (
            <div className="text-xs text-canopy-text/40 px-2">
              +{terminalErrors.length - 2} more errors
            </div>
          )}
        </div>
      )}

      {restartError && (
        <TerminalErrorBanner
          terminalId={id}
          error={restartError}
          onUpdateCwd={handleUpdateCwd}
          onRetry={handleRestart}
          onTrash={handleTrash}
        />
      )}

      {spawnError && !restartError && (
        <SpawnErrorBanner
          terminalId={id}
          error={spawnError}
          cwd={cwd}
          onUpdateCwd={handleUpdateCwd}
          onRetry={handleRestart}
          onTrash={handleTrash}
        />
      )}

      {reconnectError && !restartError && !spawnError && (
        <ReconnectErrorBanner
          terminalId={id}
          error={reconnectError}
          onDismiss={handleDismissReconnectError}
          onRestart={handleRestart}
        />
      )}

      {isExited &&
        exitCode !== null &&
        exitCode !== 0 &&
        exitCode !== 130 &&
        !dismissedRestartPrompt &&
        !restartError &&
        !isRestarting &&
        exitBehavior !== "restart" && (
          <TerminalRestartBanner
            exitCode={exitCode}
            onRestart={handleRestart}
            onDismiss={() => setDismissedRestartPrompt(true)}
          />
        )}

      {isAutoRestarting && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-canopy-text/60 bg-canopy-accent/5 border-b border-canopy-border shrink-0">
          <Loader2 className="h-3 w-3 animate-spin text-canopy-accent" />
          <span>Auto-restarting…</span>
        </div>
      )}

      {showGeminiBanner && (
        <GeminiAlternateBufferBanner terminalId={id} onDismiss={() => setShowGeminiBanner(false)} />
      )}

      <div className="flex-1 min-h-0 bg-canopy-bg flex flex-col">
        <div className="flex-1 relative min-h-0">
          <div
            className={cn(
              "absolute inset-0",
              (isBackendDisconnected || isBackendRecovering) && "pointer-events-none opacity-50"
            )}
            onPointerDownCapture={handleXtermPointerDownCapture}
          >
            <XtermAdapter
              key={`${id}-${restartKey}`}
              terminalId={id}
              terminalType={type}
              isInputLocked={isInputLocked}
              onReady={handleReady}
              onExit={handleExit}
              onInput={handleInput}
              className="absolute inset-0"
              getRefreshTier={getRefreshTierCallback}
              cwd={cwd}
            />
            <ArtifactOverlay terminalId={id} worktreeId={worktreeId} cwd={cwd} />
            {isSearchOpen && (
              <TerminalSearchBar
                terminalId={id}
                onClose={() => {
                  setIsSearchOpen(false);
                  requestAnimationFrame(() => terminalInstanceService.focus(id));
                }}
              />
            )}
          </div>

          {/* Backend Disconnect Overlay */}
          {(isBackendDisconnected || isBackendRecovering) && (
            <div
              className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
              role={isBackendRecovering ? "status" : "alert"}
              aria-live={isBackendRecovering ? "polite" : "assertive"}
            >
              {isBackendRecovering ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-8 h-8 animate-spin motion-reduce:animate-none text-amber-400" />
                  <span className="text-white font-medium">Reconnecting...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4 p-6 bg-canopy-sidebar border border-canopy-border rounded-xl shadow-2xl max-w-md text-center">
                  <div className="flex items-center gap-3 text-red-400">
                    <AlertTriangle className="w-6 h-6" />
                    <h3 className="font-semibold text-lg">
                      {lastCrashType === "OUT_OF_MEMORY"
                        ? "Memory Limit Exceeded"
                        : lastCrashType === "SIGNAL_TERMINATED"
                          ? "Terminal Service Terminated"
                          : "Connection Lost"}
                    </h3>
                  </div>

                  {lastCrashType === "OUT_OF_MEMORY" && (
                    <div className="text-sm text-canopy-text/80">
                      <p className="mb-3">
                        The terminal backend ran out of memory processing high-throughput output.
                      </p>
                      <p className="font-medium text-canopy-text/90 mb-2">Suggestions:</p>
                      <ul className="list-disc list-inside text-left space-y-1">
                        <li>Reduce agent output volume</li>
                        <li>Split long-running tasks into smaller sessions</li>
                        <li>Close unused terminals</li>
                      </ul>
                    </div>
                  )}

                  {lastCrashType === "SIGNAL_TERMINATED" && (
                    <p className="text-sm text-canopy-text/80">
                      The terminal backend became unresponsive and was automatically restarted by
                      the watchdog. Automatic recovery is in progress.
                    </p>
                  )}

                  {(lastCrashType === "UNKNOWN_CRASH" ||
                    lastCrashType === "ASSERTION_FAILURE" ||
                    !lastCrashType ||
                    (lastCrashType !== "OUT_OF_MEMORY" &&
                      lastCrashType !== "SIGNAL_TERMINATED")) && (
                    <p className="text-sm text-canopy-text/80">
                      The terminal backend process terminated unexpectedly. Automatic recovery is in
                      progress.
                    </p>
                  )}

                  <button
                    onClick={() =>
                      void actionService.dispatch("ui.refresh", undefined, { source: "user" })
                    }
                    className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg border border-red-500/30 transition-colors"
                  >
                    Restart Application
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {showHybridInputBar && (
          <HybridInputBar
            ref={inputBarRef}
            terminalId={id}
            disabled={isBackendDisconnected || isBackendRecovering || isInputLocked}
            cwd={cwd}
            agentId={effectiveAgentId}
            agentHasLifecycleEvent={stateChangeTrigger !== undefined}
            restartKey={restartKey}
            onActivate={handleClick}
            onSend={({ trackerData, text }) => {
              if (!isInputLocked) {
                if (isEscapedCommand(text)) {
                  const unescapedText = unescapeCommand(text);
                  terminalInstanceService.notifyUserInput(id);
                  terminalClient.submit(id, unescapedText);
                  handleInput(trackerData);
                  return;
                }

                const canopyCommand = getCanopyCommand(text);
                if (canopyCommand) {
                  terminalInstanceService.notifyUserInput(id);
                  void Promise.resolve(canopyCommand.execute({ terminalId: id, worktreeId })).catch(
                    (error) => {
                      console.error(`Canopy command '${canopyCommand.label}' failed:`, error);
                    }
                  );
                  return;
                }

                terminalInstanceService.notifyUserInput(id);
                terminalClient.submit(id, text);
                handleInput(trackerData);
              }
            }}
            onSendKey={(key) => {
              if (!isInputLocked) {
                terminalInstanceService.notifyUserInput(id);
                terminalClient.sendKey(id, key);
              }
            }}
          />
        )}
      </div>

      <UpdateCwdDialog
        isOpen={isUpdateCwdOpen}
        terminalId={id}
        currentCwd={cwd}
        onClose={() => setIsUpdateCwdOpen(false)}
      />
    </ContentPanel>
  );
}

export const TerminalPane = React.memo(TerminalPaneComponent);

export default TerminalPane;
