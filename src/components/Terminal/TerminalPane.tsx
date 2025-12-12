import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
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
import { ErrorBanner } from "../Errors/ErrorBanner";
import { useErrorStore, useTerminalStore, getTerminalRefreshTier } from "@/store";
import { useTerminalLogic } from "@/hooks/useTerminalLogic";
import type { AgentState } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { InputTracker } from "@/services/clearCommandDetection";
import { getAgentConfig } from "@/config/agents";

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
  const [isRestoring, setIsRestoring] = useState(true);
  const [dismissedRestartPrompt, setDismissedRestartPrompt] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isUpdateCwdOpen, setIsUpdateCwdOpen] = useState(false);

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

  const queueCount = useTerminalStore(
    useShallow((state) => state.commandQueue.filter((c) => c.terminalId === id).length)
  );

  const pingedIdSelector = useMemo(
    () => (state: ReturnType<typeof useTerminalStore.getState>) => state.pingedId === id,
    [id]
  );
  const isPinged = useTerminalStore(pingedIdSelector);

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
        // Notify service for WebGL management
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
    [id, setFocused]
  );

  const getRefreshTierCallback = useCallback(() => {
    const terminal = getTerminal(id);
    return getTerminalRefreshTier(terminal, isFocused);
  }, [id, isFocused, getTerminal]);

  const handleClick = useCallback(() => {
    setFocused(id);
    terminalInstanceService.boostRefreshRate(id);
  }, [id, setFocused]);

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

    if (isFocused) {
      requestAnimationFrame(() => {
        terminalInstanceService.focus(id);
      });
    }
  }, [isFocused, id]);

  // Sync agent state to terminal service for scroll management
  useEffect(() => {
    terminalInstanceService.setAgentState(id, agentState ?? "idle");
  }, [id, agentState]);

  const isWorking = agentState === "working";

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col h-full overflow-hidden group",

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
        location === "grid" && isMaximized && "border-0 rounded-none z-50",

        isExited && "opacity-75 grayscale",

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
        const effectiveAgentId = agentId ?? type;
        if (!effectiveAgentId || effectiveAgentId === "terminal") {
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

      <div className="flex-1 relative min-h-0 bg-canopy-bg">
        <XtermAdapter
          key={`${id}-${restartKey}`}
          terminalId={id}
          terminalType={type}
          agentId={agentId}
          onReady={handleReady}
          onExit={handleExit}
          onInput={handleInput}
          className={cn("absolute", location === "dock" || isMaximized ? "inset-0" : "inset-2")}
          getRefreshTier={getRefreshTierCallback}
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
