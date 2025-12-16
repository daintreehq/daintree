import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, Loader2, ArrowDown } from "lucide-react";
import type { TerminalType, TerminalRestartError } from "@/types";
import { cn } from "@/lib/utils";
import { getTerminalAnimationDuration } from "@/lib/animationUtils";
import { XtermAdapter } from "./XtermAdapter";
import { ArtifactOverlay } from "./ArtifactOverlay";
import { TerminalHeader } from "./TerminalHeader";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { TerminalRestartBanner } from "./TerminalRestartBanner";
import { TerminalErrorBanner } from "./TerminalErrorBanner";
import { UpdateCwdDialog } from "./UpdateCwdDialog";
import { SnapshotTerminalView } from "./SnapshotTerminalView";
import { ErrorBanner } from "../Errors/ErrorBanner";
import {
  useErrorStore,
  useTerminalStore,
  getTerminalRefreshTier,
  useTerminalInputStore,
} from "@/store";
import { useTerminalLogic } from "@/hooks/useTerminalLogic";
import type { AgentState } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { InputTracker } from "@/services/clearCommandDetection";
import { getAgentConfig } from "@/config/agents";
import { terminalClient } from "@/clients";
import { HybridInputBar, type HybridInputBarHandle } from "./HybridInputBar";
import { getTerminalFocusTarget } from "./terminalFocus";
import { useTerminalUnseenOutput } from "@/hooks/useTerminalUnseenOutput";
import { TerminalRefreshTier } from "@/types";

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
  /** Counter incremented on restart to trigger XtermAdapter re-mount */
  restartKey?: number;
  /** Terminal is animating out before being trashed */
  isTrashing?: boolean;
  /** Error from a failed restart attempt */
  restartError?: TerminalRestartError;
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
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevFocusedRef = useRef(isFocused);
  const justFocusedUntilRef = useRef<number>(0);
  const inputBarRef = useRef<HybridInputBarHandle>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [dismissedRestartPrompt, setDismissedRestartPrompt] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isUpdateCwdOpen, setIsUpdateCwdOpen] = useState(false);
  const [forceLiveKey, setForceLiveKey] = useState(0);

  const unseenOutput = useTerminalUnseenOutput(id);

  if (isFocused && !prevFocusedRef.current) {
    justFocusedUntilRef.current = performance.now() + 250;
  }

  useEffect(() => {
    prevFocusedRef.current = isFocused;
  }, [isFocused]);

  useEffect(() => {
    if (!isRestoring) return;
    const duration = getTerminalAnimationDuration();
    const timer = setTimeout(() => setIsRestoring(false), duration);
    return () => clearTimeout(timer);
  }, [isRestoring]);

  useEffect(() => {
    setDismissedRestartPrompt(false);
    inputTrackerRef.current?.reset();
  }, [restartKey]);

  const updateVisibility = useTerminalStore((state) => state.updateVisibility);
  const getTerminal = useTerminalStore((state) => state.getTerminal);
  const restartTerminal = useTerminalStore((state) => state.restartTerminal);
  const trashTerminal = useTerminalStore((state) => state.trashTerminal);
  const setFocused = useTerminalStore((state) => state.setFocused);
  const updateLastCommand = useTerminalStore((state) => state.updateLastCommand);
  const backendStatus = useTerminalStore((state) => state.backendStatus);
  const lastCrashType = useTerminalStore((state) => state.lastCrashType);
  const isInputLocked = useTerminalStore(
    (state) => state.terminals.find((t) => t.id === id)?.isInputLocked ?? false
  );

  const isBackendDisconnected = backendStatus === "disconnected";
  const isBackendRecovering = backendStatus === "recovering";
  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((state) => state.hybridInputAutoFocus);
  const effectiveAgentId =
    agentId === "claude" || agentId === "gemini" || agentId === "codex"
      ? agentId
      : type === "claude" || type === "gemini" || type === "codex"
        ? type
        : undefined;
  const isAgentTerminal = effectiveAgentId !== undefined;
  const showHybridInputBar = isAgentTerminal && hybridInputEnabled;

  const terminal = getTerminal(id);
  const isSnapshotMode = isAgentTerminal;
  const refreshTier = getTerminalRefreshTier(terminal, isFocused);
  const snapshotRefreshMs =
    refreshTier === TerminalRefreshTier.FOCUSED
      ? 50
      : refreshTier === TerminalRefreshTier.VISIBLE
        ? 150
        : 0;
  const isVisible = terminal?.isVisible ?? false;

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

  const {
    isEditingTitle,
    editingValue,
    titleInputRef,
    setEditingValue,
    handleTitleDoubleClick,
    handleTitleKeyDown,
    handleTitleInputKeyDown,
    handleTitleSave,
    isExited,
    exitCode,
    handleExit,
    handleErrorRetry,
  } = useTerminalLogic({
    id,
    title,
    onTitleChange,
    removeError,
    restartKey,
  });

  // Visibility observation
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        updateVisibility(id, entry.isIntersecting);
        // Notify service for visibility-aware terminal management
        terminalInstanceService.setVisible(id, entry.isIntersecting);
      },
      {
        threshold: 0.1,
      }
    );

    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
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
        // Intercept user-initiated clear commands to provide immediate visual feedback.
        // This is separate from blocking agent-generated escape sequences (handled by
        // setupParserHandlers in TerminalInstanceService) which prevent dangerous
        // screen jumping that could trigger photosensitive epileptic seizures.
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;

      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        if (isSnapshotMode) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsSearchOpen(true);
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>("[data-terminal-search-input]")?.focus();
        });
        return;
      }

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
    [id, isSnapshotMode, setFocused]
  );

  const getRefreshTierCallback = useCallback(() => {
    const terminal = getTerminal(id);
    return getTerminalRefreshTier(terminal, isFocused);
  }, [id, isFocused, getTerminal]);

  const handleClick = useCallback(() => {
    setFocused(id);
    terminalInstanceService.boostRefreshRate(id);
  }, [id, setFocused]);

  const handleXtermPointerDownCapture = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;

      const target = e.target as HTMLElement | null;
      if (!target?.closest(".xterm")) return;

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
      requestAnimationFrame(() => inputBarRef.current?.focus());
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

  useEffect(() => {
    terminalInstanceService.setFocused(id, isFocused);

    if (!isFocused) return;

    const focusTarget = getTerminalFocusTarget({
      isAgentTerminal,
      isInputDisabled: isBackendDisconnected || isBackendRecovering,
      hybridInputEnabled,
      hybridInputAutoFocus,
    });

    if (focusTarget === "hybridInput") {
      const timeoutId = window.setTimeout(() => {
        inputBarRef.current?.focus();
      }, 10);
      return () => window.clearTimeout(timeoutId);
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
  ]);

  // Sync agent state to terminal service for scroll management
  useEffect(() => {
    terminalInstanceService.setAgentState(id, agentState ?? "idle");
  }, [id, agentState]);

  const isWorking = agentState === "working";

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col h-full overflow-hidden group terminal-pane",

        // Background color: surface tint for cards, canvas for maximized
        // When focused, .terminal-selected handles the background color
        location === "grid" && !isMaximized && !isFocused && "bg-[var(--color-surface)]",
        (location === "dock" || isMaximized) && "bg-canopy-bg",

        // Grid styles (standard - non-maximized)
        location === "grid" && !isMaximized && "rounded border shadow-md",
        location === "grid" &&
          !isMaximized &&
          (isFocused ? "terminal-selected" : "border-canopy-border hover:border-white/10"),

        // Zen Mode styles (maximized - full immersion, no inset needed)
        location === "grid" && isMaximized && "border-0 rounded-none z-[var(--z-modal)]",

        isExited && "opacity-75 grayscale",

        isPinged &&
          !isMaximized &&
          (wasJustSelected ? "animate-terminal-ping-select" : "animate-terminal-ping"),

        // Restore animation on mount (skip if trashing)
        isRestoring && !isTrashing && "terminal-restoring",

        // Trash animation when being removed
        isTrashing && "terminal-trashing"
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
      <TerminalHeader
        id={id}
        title={title}
        type={type}
        isFocused={isFocused}
        isExited={isExited}
        exitCode={exitCode}
        isWorking={isWorking}
        agentState={agentState}
        activity={activity}
        lastCommand={lastCommand}
        queueCount={queueCount}
        flowStatus={flowStatus}
        isEditingTitle={isEditingTitle}
        editingValue={editingValue}
        titleInputRef={titleInputRef}
        onEditingValueChange={setEditingValue}
        onTitleDoubleClick={handleTitleDoubleClick}
        onTitleKeyDown={handleTitleKeyDown}
        onTitleInputKeyDown={handleTitleInputKeyDown}
        onTitleSave={handleTitleSave}
        onClose={onClose}
        onFocus={onFocus}
        onToggleMaximize={onToggleMaximize}
        onTitleChange={onTitleChange}
        onMinimize={onMinimize}
        onRestore={onRestore}
        onRestart={handleRestart}
        isMaximized={isMaximized}
        location={location}
        isPinged={isPinged}
        wasJustSelected={wasJustSelected}
      />

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

      {isExited &&
        exitCode !== null &&
        exitCode !== 0 &&
        exitCode !== 130 &&
        !dismissedRestartPrompt &&
        !restartError && (
          <TerminalRestartBanner
            exitCode={exitCode}
            onRestart={handleRestart}
            onDismiss={() => setDismissedRestartPrompt(true)}
          />
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
            {isSnapshotMode ? (
              <SnapshotTerminalView
                terminalId={id}
                isFocused={isFocused}
                isVisible={isVisible}
                refreshMs={snapshotRefreshMs}
                isInputLocked={isInputLocked}
                forceLiveKey={forceLiveKey}
              />
            ) : (
              <XtermAdapter
                key={`${id}-${restartKey}`}
                terminalId={id}
                terminalType={type}
                agentId={agentId}
                isInputLocked={isInputLocked}
                onReady={handleReady}
                onExit={handleExit}
                onInput={handleInput}
                className="absolute inset-0"
                getRefreshTier={getRefreshTierCallback}
              />
            )}
            <ArtifactOverlay terminalId={id} worktreeId={worktreeId} cwd={cwd} />
            {!isSnapshotMode && unseenOutput.isUserScrolledBack && unseenOutput.unseen > 0 && (
              <button
                onClick={() => {
                  terminalInstanceService.resumeAutoScroll(id);
                  requestAnimationFrame(() => terminalInstanceService.focus(id));
                }}
                className="absolute bottom-4 left-4 z-10 flex items-center gap-2 bg-canopy-primary text-canopy-primary-fg px-3 py-2 rounded-md shadow-lg hover:bg-canopy-primary/90 transition-colors"
                aria-label="Resume auto-scroll"
              >
                <ArrowDown className="h-4 w-4" />
                <span className="text-sm font-medium">Resume</span>
              </button>
            )}
            {!isSnapshotMode && isSearchOpen && (
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
                  <Loader2 className="w-8 h-8 animate-spin text-amber-400" />
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
                    onClick={() => window.location.reload()}
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
            disabled={isBackendDisconnected || isBackendRecovering || isInputLocked}
            cwd={cwd}
            agentId={effectiveAgentId}
            onSend={({ trackerData, text }) => {
              if (!isInputLocked) {
                setForceLiveKey((k) => k + 1);
                terminalInstanceService.notifyUserInput(id);
                // Use backend submit() which handles Codex vs other agents automatically
                terminalClient.submit(id, text);
                // Feed tracker data for features like clear command detection
                handleInput(trackerData);
              }
            }}
            onSendKey={(key) => {
              if (!isInputLocked) {
                setForceLiveKey((k) => k + 1);
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
    </div>
  );
}

export const TerminalPane = React.memo(TerminalPaneComponent);

export default TerminalPane;
