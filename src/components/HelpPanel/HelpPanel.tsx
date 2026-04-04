import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { X, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { CanopyIcon } from "@/components/icons/CanopyIcon";
import { XtermAdapter } from "@/components/Terminal/XtermAdapter";
import { HelpAgentPicker } from "./HelpAgentPicker";
import {
  useHelpPanelStore,
  HELP_PANEL_MIN_WIDTH,
  HELP_PANEL_MAX_WIDTH,
} from "@/store/helpPanelStore";
import { useTerminalStore, getTerminalRefreshTier } from "@/store";
import { AGENT_REGISTRY } from "@/config/agents";
import { AGENT_REGISTRY as SHARED_AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { actionService } from "@/services/ActionService";
import { TerminalRefreshTier } from "@/types";
import type { TerminalType } from "@/types";

const RESIZE_STEP = 10;

const HELP_PROMPT =
  "I need help with Canopy, an Electron-based IDE for orchestrating AI coding agents. Please briefly tell me how you can help.";

export function HelpPanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const {
    isOpen,
    width,
    terminalId,
    agentId,
    preferredAgentId,
    setWidth,
    setOpen,
    clearTerminal,
    clearPreferredAgent,
  } = useHelpPanelStore();

  const terminal = useTerminalStore((s) => (terminalId ? s.terminalsById[terminalId] : undefined));
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const addTerminal = useTerminalStore((s) => s.addTerminal);

  const agentConfig = agentId ? AGENT_REGISTRY[agentId] : undefined;

  // Clean up help terminal before window unload so it doesn't persist as a dock terminal
  useEffect(() => {
    const handler = () => {
      const { terminalId: tid } = useHelpPanelStore.getState();
      if (tid) {
        useTerminalStore.getState().removeTerminal(tid);
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Auto-launch preferred agent when panel opens without an active terminal.
  // Uses the agent's continueCommand to resume the last session in the help folder.
  const hasAutoLaunched = useRef(false);
  useEffect(() => {
    if (!isOpen || terminalId || !preferredAgentId || hasAutoLaunched.current) return;
    hasAutoLaunched.current = true;

    void (async () => {
      const folderPath = await window.electron.help.getFolderPath();
      if (!folderPath) return;

      const sharedConfig =
        SHARED_AGENT_REGISTRY[preferredAgentId as keyof typeof SHARED_AGENT_REGISTRY];
      const continueCommand = sharedConfig?.help?.continueCommand;

      if (continueCommand) {
        // Use the continue command to resume last session in this folder
        const newId = await addTerminal({
          kind: "agent",
          type: preferredAgentId as TerminalType,
          agentId: preferredAgentId,
          cwd: folderPath,
          command: continueCommand,
          location: "dock",
        });
        if (newId) {
          useHelpPanelStore.getState().setTerminal(newId, preferredAgentId);
        }
      } else {
        // Fallback: standard launch with help prompt
        const result = await actionService.dispatch<{ terminalId: string | null }>(
          "agent.launch",
          { agentId: preferredAgentId, location: "dock", cwd: folderPath, prompt: HELP_PROMPT },
          { source: "user" }
        );
        if (result.ok && result.result?.terminalId) {
          useHelpPanelStore.getState().setTerminal(result.result.terminalId, preferredAgentId);
        }
      }
    })();
  }, [isOpen, terminalId, preferredAgentId, addTerminal]);

  // Reset auto-launch guard when panel closes
  useEffect(() => {
    if (!isOpen) {
      hasAutoLaunched.current = false;
    }
  }, [isOpen]);

  // Click-away handler
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest('[aria-label="Help Agent"]')) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, setOpen]);

  // Resize via mouse drag
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = width;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        const newWidth = Math.min(
          Math.max(startWidth + delta, HELP_PANEL_MIN_WIDTH),
          HELP_PANEL_MAX_WIDTH
        );
        setWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [width, setWidth]
  );

  // Resize via keyboard
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setWidth(width + RESIZE_STEP);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setWidth(width - RESIZE_STEP);
      }
    },
    [width, setWidth]
  );

  const handleSelectAgent = useCallback(
    async (selectedAgentId: string) => {
      // Remove existing terminal if switching agents
      if (terminalId) {
        removeTerminal(terminalId);
        clearTerminal();
      }

      const folderPath = await window.electron.help.getFolderPath();
      if (!folderPath) return;

      const result = await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        { agentId: selectedAgentId, location: "dock", cwd: folderPath, prompt: HELP_PROMPT },
        { source: "user" }
      );

      if (result.ok && result.result?.terminalId) {
        useHelpPanelStore.getState().setTerminal(result.result.terminalId, selectedAgentId);
      }
    },
    [terminalId, removeTerminal, clearTerminal]
  );

  const handleBack = useCallback(() => {
    if (terminalId) {
      removeTerminal(terminalId);
    }
    clearPreferredAgent();
  }, [terminalId, removeTerminal, clearPreferredAgent]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const getRefreshTier = useMemo(() => {
    return () => {
      if (!isOpen) return TerminalRefreshTier.BACKGROUND;
      return getTerminalRefreshTier(terminal, true);
    };
  }, [isOpen, terminal]);

  const showTerminal = terminalId && terminal;

  return (
    <div
      ref={panelRef}
      className={cn(
        "flex flex-col h-full bg-canopy-bg relative",
        "border-l border-canopy-border shadow-2xl"
      )}
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize help panel"
        tabIndex={0}
        className={cn(
          "absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10",
          "hover:bg-canopy-accent/20 active:bg-canopy-accent/30 transition-colors",
          isResizing && "bg-canopy-accent/30"
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-canopy-border shrink-0">
        {showTerminal && (
          <button
            type="button"
            onClick={handleBack}
            className="p-1 rounded-[var(--radius-sm)] text-canopy-text/50 hover:text-canopy-text hover:bg-tint/8 transition-colors"
            aria-label="Back to agent picker"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <CanopyIcon className="w-4 h-4 mr-0.5 text-canopy-text/50 shrink-0" />
          <span className="text-xs font-medium text-canopy-text/70 truncate">
            Canopy Assistant
            {agentConfig && (
              <span className="text-canopy-text/40">
                {" — "}
                <agentConfig.icon className="w-3 h-3 inline-block align-[-0.15em]" />
                {` ${agentConfig.name}`}
              </span>
            )}
          </span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="p-1 rounded-[var(--radius-sm)] text-canopy-text/50 hover:text-canopy-text hover:bg-tint/8 transition-colors"
          aria-label="Close help panel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 flex flex-col min-h-0 relative">
        {showTerminal ? (
          <div className="absolute inset-0">
            <XtermAdapter
              terminalId={terminalId}
              terminalType={(agentId ?? "terminal") as TerminalType}
              getRefreshTier={getRefreshTier}
              cwd={terminal.cwd}
            />
          </div>
        ) : (
          <HelpAgentPicker onSelectAgent={handleSelectAgent} />
        )}
      </div>
    </div>
  );
}
