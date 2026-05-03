import { Suspense, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { X, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { XtermAdapter } from "@/components/Terminal/XtermAdapter";
import { MissingCliGate } from "@/components/Terminal/MissingCliGate";
import { HelpAgentPicker } from "./HelpAgentPicker";
import { HelpIntroBanner } from "./HelpIntroBanner";
import {
  useHelpPanelStore,
  HELP_PANEL_MIN_WIDTH,
  HELP_PANEL_MAX_WIDTH,
} from "@/store/helpPanelStore";
import {
  usePanelStore,
  getTerminalRefreshTier,
  useCliAvailabilityStore,
  useProjectStore,
} from "@/store";
import { getAgentConfig, getAssistantSupportedAgentIds } from "@/config/agents";
import { isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { actionService } from "@/services/ActionService";
import { TerminalRefreshTier } from "@/types";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

const RESIZE_STEP = 10;

const ASSISTANT_DOCS_URL = "https://daintree.org/assistant";

function notifyLaunchFailed(agentId: string, reason: string): void {
  const cfg = getAgentConfig(agentId);
  const name = cfg?.name ?? agentId;
  notify({
    type: "error",
    title: "Assistant launch failed",
    message: `Couldn't start ${name}. ${reason}`,
  });
}

interface HelpSessionRef {
  sessionId: string;
  sessionPath: string;
  token: string;
  mcpUrl: string | null;
  windowId: number;
}

async function provisionHelpSession(): Promise<HelpSessionRef | null> {
  const project = useProjectStore.getState().currentProject;
  if (!project) return null;
  try {
    const result = await window.electron.help.provisionSession({
      projectId: project.id,
      projectPath: project.path,
    });
    return result;
  } catch (err) {
    logError("Failed to provision help session", err);
    return null;
  }
}

function buildHelpEnv(
  session: HelpSessionRef | null,
  projectId: string | null
): Record<string, string> | undefined {
  if (!session) return undefined;
  const env: Record<string, string> = {
    DAINTREE_MCP_TOKEN: session.token,
    DAINTREE_WINDOW_ID: String(session.windowId),
  };
  if (session.mcpUrl) env.DAINTREE_MCP_URL = session.mcpUrl;
  if (projectId) env.DAINTREE_PROJECT_ID = projectId;
  return env;
}

function revokeHelpSession(sessionId: string | null): void {
  if (!sessionId) return;
  window.electron.help.revokeSession(sessionId).catch((err) => {
    logError("Failed to revoke help session", err);
  });
}

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
    introDismissed,
    setWidth,
    setOpen,
    clearTerminal,
    clearPreferredAgent,
    dismissIntro,
  } = useHelpPanelStore();

  const terminal = usePanelStore((s) => (terminalId ? s.panelsById[terminalId] : undefined));
  const removePanel = usePanelStore((s) => s.removePanel);
  const cliDetail = useCliAvailabilityStore((s) => (agentId ? s.details[agentId] : undefined));
  const cliAvailability = useCliAvailabilityStore((s) => s.availability);
  const cliHasRealData = useCliAvailabilityStore((s) => s.hasRealData);

  const agentConfig = agentId ? getAgentConfig(agentId) : undefined;

  // Intersection of "wired for the assistant overlay" and "CLI is installed".
  // Drives the picker's visible options and the single-supported-agent
  // auto-skip effect below. Recomputes only when availability or load state
  // changes — `getAssistantSupportedAgentIds()` reads from a static registry.
  const supportedInstalledAgentIds = useMemo(() => {
    if (!cliHasRealData) return [];
    return getAssistantSupportedAgentIds().filter((id) => isAgentInstalled(cliAvailability[id]));
  }, [cliHasRealData, cliAvailability]);
  const supportedInstalledAgentIdsKey = supportedInstalledAgentIds.join(",");

  // Tracks a session minted before `setTerminal` commits its sessionId to the
  // store. If the user closes/navigates while `agent.launch` is in flight,
  // cleanup paths revoke this ref so the token isn't leaked until 7-day GC.
  const pendingSessionIdRef = useRef<string | null>(null);

  const revokePendingSession = useCallback(() => {
    const pending = pendingSessionIdRef.current;
    if (pending) {
      pendingSessionIdRef.current = null;
      revokeHelpSession(pending);
    }
  }, []);

  // Revoke the bound help session if the underlying PTY panel disappears from
  // the panel store. addPanel puts the placeholder in panelsById before
  // setTerminal records the id here, so a missing entry means the process
  // exited and removePanel was called from elsewhere.
  useEffect(() => {
    if (terminalId && !terminal) {
      const { sessionId } = useHelpPanelStore.getState();
      revokeHelpSession(sessionId);
      clearTerminal();
    }
  }, [terminalId, terminal, clearTerminal]);

  // Clean up help terminal when the view becomes hidden (project switch, window close).
  // In Electron 41, beforeunload does not fire on WebContentsView detach, but
  // visibilitychange does — this covers both project switches and window unload.
  useEffect(() => {
    const handler = () => {
      if (!document.hidden) return;
      const state = useHelpPanelStore.getState();
      if (state.terminalId) {
        usePanelStore.getState().removePanel(state.terminalId);
        revokeHelpSession(state.sessionId);
        useHelpPanelStore.getState().clearTerminal();
      }
      revokePendingSession();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [revokePendingSession]);

  // Auto-launch preferred agent when panel opens without an active terminal.
  // Always starts a new conversation (never resumes).
  const hasAutoLaunched = useRef(false);
  useEffect(() => {
    if (!isOpen || terminalId || !preferredAgentId || hasAutoLaunched.current) return;
    const launchAgentId = preferredAgentId;
    hasAutoLaunched.current = true;

    safeFireAndForget(
      (async () => {
        const folderPath = await window.electron.help.getFolderPath();
        if (!folderPath) {
          hasAutoLaunched.current = false;
          notifyLaunchFailed(launchAgentId, "Help folder is not available.");
          return;
        }

        const session = await provisionHelpSession();
        if (session) pendingSessionIdRef.current = session.sessionId;
        const cwd = session?.sessionPath ?? folderPath;
        const projectId = useProjectStore.getState().currentProject?.id ?? null;
        const env = buildHelpEnv(session, projectId);

        const result = await actionService.dispatch<{ terminalId: string | null }>(
          "agent.launch",
          {
            agentId: launchAgentId,
            location: "dock",
            cwd,
            ephemeral: true,
            ...(env && { env }),
          },
          { source: "user" }
        );

        // Stale-launch guard: if the user navigated back to the picker or
        // switched preferred agent while the IPC was in flight, discard
        // this result and clean up the spawned panel rather than reviving
        // a stale terminal. Reset hasAutoLaunched so the next preferred
        // agent (if any) can auto-launch on the next effect tick.
        const currentPreferred = useHelpPanelStore.getState().preferredAgentId;
        if (currentPreferred !== launchAgentId) {
          if (result.ok && result.result?.terminalId) {
            usePanelStore.getState().removePanel(result.result.terminalId);
          }
          revokeHelpSession(session?.sessionId ?? null);
          pendingSessionIdRef.current = null;
          hasAutoLaunched.current = false;
          return;
        }

        if (!result.ok || !result.result?.terminalId) {
          hasAutoLaunched.current = false;
          revokeHelpSession(session?.sessionId ?? null);
          pendingSessionIdRef.current = null;
          logError("Help auto-launch failed", { agentId: launchAgentId, result });
          notifyLaunchFailed(launchAgentId, "The agent didn't start. Try again.");
          return;
        }

        // Stale-launch guard: handleClose / handleBack revoked the pending
        // session via revokePendingSession (clearing the ref). Drop the orphan
        // terminal rather than binding a panel to a revoked token.
        const expectedSessionId = session?.sessionId ?? null;
        if (expectedSessionId && pendingSessionIdRef.current !== expectedSessionId) {
          usePanelStore.getState().removePanel(result.result.terminalId);
          hasAutoLaunched.current = false;
          return;
        }

        useHelpPanelStore
          .getState()
          .setTerminal(result.result.terminalId, launchAgentId, session?.sessionId ?? null);
        pendingSessionIdRef.current = null;
        window.electron.help.markTerminal(result.result.terminalId).catch((err) => {
          logError("Failed to mark help terminal", err);
        });
      })(),
      { context: "Auto-launching preferred help agent" }
    );
  }, [isOpen, terminalId, preferredAgentId]);

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

  const isLaunchingRef = useRef(false);
  const handleSelectAgent = useCallback(
    async (selectedAgentId: string) => {
      if (isLaunchingRef.current) return;
      isLaunchingRef.current = true;

      try {
        // Remove existing terminal if switching agents
        const existing = useHelpPanelStore.getState();
        if (existing.terminalId) {
          removePanel(existing.terminalId);
          revokeHelpSession(existing.sessionId);
          clearTerminal();
        }

        const folderPath = await window.electron.help.getFolderPath();
        if (!folderPath) {
          notifyLaunchFailed(selectedAgentId, "Help folder is not available.");
          return;
        }

        const session = await provisionHelpSession();
        if (session) pendingSessionIdRef.current = session.sessionId;
        const cwd = session?.sessionPath ?? folderPath;
        const projectId = useProjectStore.getState().currentProject?.id ?? null;
        const env = buildHelpEnv(session, projectId);

        const result = await actionService.dispatch<{ terminalId: string | null }>(
          "agent.launch",
          {
            agentId: selectedAgentId,
            location: "dock",
            cwd,
            ephemeral: true,
            ...(env && { env }),
          },
          { source: "user" }
        );

        if (!result.ok || !result.result?.terminalId) {
          revokeHelpSession(session?.sessionId ?? null);
          pendingSessionIdRef.current = null;
          logError("Help launch failed", { agentId: selectedAgentId, result });
          notifyLaunchFailed(selectedAgentId, "The agent didn't start. Try again.");
          return;
        }

        // Stale-launch guard: if handleClose / handleBack revoked the pending
        // session while dispatch was in-flight, the session is dead. Drop the
        // orphan terminal rather than binding a panel to a revoked token.
        const expectedSessionId = session?.sessionId ?? null;
        if (expectedSessionId && pendingSessionIdRef.current !== expectedSessionId) {
          usePanelStore.getState().removePanel(result.result.terminalId);
          return;
        }

        useHelpPanelStore
          .getState()
          .setTerminal(result.result.terminalId, selectedAgentId, session?.sessionId ?? null);
        pendingSessionIdRef.current = null;
        window.electron.help.markTerminal(result.result.terminalId).catch((err) => {
          logError("Failed to mark help terminal", err);
        });
      } finally {
        isLaunchingRef.current = false;
      }
    },
    [removePanel, clearTerminal]
  );

  // Single-supported-agent auto-skip: when only one assistant-supported agent
  // is installed and there's no persisted preference, skip the picker and
  // launch directly. Mutually exclusive with the preferred-agent auto-launch
  // (which only runs when `preferredAgentId` is set), so they share the same
  // `hasAutoLaunched` ref to prevent any double-fire.
  useEffect(() => {
    if (!isOpen || terminalId || preferredAgentId || hasAutoLaunched.current) return;
    if (supportedInstalledAgentIds.length !== 1) return;
    const onlyAgentId = supportedInstalledAgentIds[0];
    if (!onlyAgentId) return;
    hasAutoLaunched.current = true;
    safeFireAndForget(handleSelectAgent(onlyAgentId), {
      context: "Auto-launching single supported help agent",
    });
    // The agent-id key is included in deps so a change in installed agents
    // (e.g. user installs a second supported CLI) re-evaluates the gate.
  }, [
    isOpen,
    terminalId,
    preferredAgentId,
    supportedInstalledAgentIdsKey,
    supportedInstalledAgentIds,
    handleSelectAgent,
  ]);

  const handleBack = useCallback(() => {
    const { sessionId } = useHelpPanelStore.getState();
    if (terminalId) {
      removePanel(terminalId);
    }
    revokeHelpSession(sessionId);
    revokePendingSession();
    hasAutoLaunched.current = false;
    clearPreferredAgent();
  }, [terminalId, removePanel, clearPreferredAgent, revokePendingSession]);

  const handleClose = useCallback(() => {
    const { sessionId } = useHelpPanelStore.getState();
    if (terminalId) {
      removePanel(terminalId);
      clearTerminal();
    }
    revokeHelpSession(sessionId);
    revokePendingSession();
    setOpen(false);
  }, [terminalId, removePanel, clearTerminal, setOpen, revokePendingSession]);

  const handleIntroLinkClick = useCallback(() => {
    dismissIntro();
    void actionService.dispatch(
      "system.openExternal",
      { url: ASSISTANT_DOCS_URL },
      { source: "user" }
    );
  }, [dismissIntro]);

  const handleRunAnyway = useCallback(() => {
    if (!terminalId || !agentId) return;
    if (isLaunchingRef.current) return;
    const panel = usePanelStore.getState().panelsById[terminalId];
    if (!panel) return;
    const presetEnv = panel.extensionState?.presetEnv as Record<string, string> | undefined;
    const launchAgentId = agentId;
    const previousSessionId = useHelpPanelStore.getState().sessionId;

    isLaunchingRef.current = true;
    removePanel(terminalId);
    revokeHelpSession(previousSessionId);
    clearTerminal();

    safeFireAndForget(
      (async () => {
        let session: HelpSessionRef | null = null;
        try {
          session = await provisionHelpSession();
          const cwd = session?.sessionPath ?? panel.cwd ?? "";
          const projectId = useProjectStore.getState().currentProject?.id ?? null;
          const helpEnv = buildHelpEnv(session, projectId);
          const env: Record<string, string> | undefined =
            helpEnv || presetEnv ? { ...(presetEnv ?? {}), ...(helpEnv ?? {}) } : undefined;

          const newId = await usePanelStore.getState().addPanel({
            kind: "terminal",
            launchAgentId,
            command: panel.command,
            title: panel.title,
            cwd,
            worktreeId: panel.worktreeId,
            location: panel.location as "grid" | "dock" | undefined,
            agentLaunchFlags: panel.agentLaunchFlags,
            agentModelId: panel.agentModelId,
            agentPresetId: panel.agentPresetId,
            env,
          });

          if (!newId) {
            revokeHelpSession(session?.sessionId ?? null);
            logError("Help run-anyway returned no terminal id", { agentId: launchAgentId });
            notifyLaunchFailed(launchAgentId, "The agent didn't start. Try again.");
            return;
          }

          useHelpPanelStore
            .getState()
            .setTerminal(newId, launchAgentId, session?.sessionId ?? null);
          window.electron.help.markTerminal(newId).catch((err) => {
            logError("Failed to mark help terminal", err);
          });
        } catch (error) {
          revokeHelpSession(session?.sessionId ?? null);
          logError("Help run-anyway failed", error);
          notifyLaunchFailed(launchAgentId, "The agent didn't start. Try again.");
        } finally {
          isLaunchingRef.current = false;
        }
      })(),
      { context: "Help: run-anyway re-launch" }
    );
  }, [terminalId, agentId, removePanel, clearTerminal]);

  const getRefreshTier = useMemo(() => {
    return () => {
      if (!isOpen) return TerminalRefreshTier.BACKGROUND;
      return getTerminalRefreshTier(terminal, true);
    };
  }, [isOpen, terminal]);

  const showTerminal = terminalId && terminal;
  const isMissingCli = showTerminal && terminal?.spawnStatus === "missing-cli";

  return (
    <div
      ref={panelRef}
      className={cn(
        "flex flex-col h-full bg-daintree-bg relative",
        "border-l border-daintree-border shadow-2xl"
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
          "hover:bg-overlay-soft active:bg-overlay-medium transition-colors",
          isResizing && "bg-overlay-medium"
        )}
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-daintree-border shrink-0">
        {showTerminal && supportedInstalledAgentIds.length > 1 && (
          <button
            type="button"
            onClick={handleBack}
            className="p-1 rounded-[var(--radius-sm)] text-daintree-text/50 hover:text-daintree-text hover:bg-tint/8 transition-colors"
            aria-label="Back to agent picker"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex items-center min-w-0 flex-1">
          <DaintreeIcon className="w-4 h-4 text-daintree-text/50 shrink-0" />
          <span className="ml-1.5 text-xs font-medium text-daintree-text/70 truncate">
            Daintree Assistant
          </span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="p-1 rounded-[var(--radius-sm)] text-daintree-text/50 hover:text-daintree-text hover:bg-tint/8 transition-colors"
          aria-label="Close help panel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 flex flex-col min-h-0 relative">
        {showTerminal ? (
          isMissingCli && agentId ? (
            <MissingCliGate
              agentId={agentId}
              detail={cliDetail ?? { state: "missing", resolvedPath: null, via: null }}
              onRunAnyway={handleRunAnyway}
            />
          ) : (
            <>
              {!introDismissed && (
                <HelpIntroBanner onDismiss={dismissIntro} onLinkClick={handleIntroLinkClick} />
              )}
              <div className="flex-1 relative min-h-0">
                <Suspense fallback={null}>
                  <XtermAdapter
                    terminalId={terminalId}
                    launchAgentId={agentId ?? undefined}
                    getRefreshTier={getRefreshTier}
                    cwd={terminal.cwd}
                  />
                </Suspense>
              </div>
            </>
          )
        ) : (
          <HelpAgentPicker
            onSelectAgent={handleSelectAgent}
            supportedAgentIds={supportedInstalledAgentIds}
          />
        )}
      </div>

      {/* Bottom info bar */}
      {showTerminal && agentConfig && !isMissingCli && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-daintree-border shrink-0 text-[11px] text-daintree-text/40">
          <span className="flex items-center gap-1">
            Using
            <agentConfig.icon className="w-3.5 h-3.5" />
            {agentConfig.name}
          </span>
          <a
            href="https://daintree.org"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-daintree-text/60 transition-colors"
          >
            <DaintreeIcon className="w-3.5 h-3.5" />
            Daintree.org
          </a>
        </div>
      )}
    </div>
  );
}
