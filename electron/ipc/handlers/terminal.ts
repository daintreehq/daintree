import { ipcMain, dialog } from "electron";
import crypto from "crypto";
import os from "os";
import path from "path";
import { CHANNELS } from "../channels.js";
import { sendToRenderer } from "../utils.js";
import { projectStore } from "../../services/ProjectStore.js";
import { events, type CanopyEventMap } from "../../services/events.js";
import type { HandlerDependencies } from "../types.js";
import type { TerminalSpawnOptions, TerminalResizePayload } from "../../types/index.js";
import { TerminalSpawnOptionsSchema, TerminalResizePayloadSchema } from "../../schemas/ipc.js";
import type { PtyHostActivityTier } from "../../../shared/types/pty-host.js";

export function registerTerminalHandlers(deps: HandlerDependencies): () => void {
  const { mainWindow, ptyClient, worktreeService: workspaceClient } = deps;

  const handlers: Array<() => void> = [];

  const handlePtyData = (id: string, data: string | Uint8Array) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_DATA, id, data);
  };
  ptyClient.on("data", handlePtyData);
  handlers.push(() => ptyClient.off("data", handlePtyData));

  const handlePtyExit = (id: string, exitCode: number) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_EXIT, id, exitCode);
  };
  ptyClient.on("exit", handlePtyExit);
  handlers.push(() => ptyClient.off("exit", handlePtyExit));

  const handlePtyError = (id: string, error: string) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_ERROR, id, error);
  };
  ptyClient.on("error", handlePtyError);
  handlers.push(() => ptyClient.off("error", handlePtyError));

  const unsubAgentState = events.on("agent:state-changed", (payload: unknown) => {
    sendToRenderer(mainWindow, CHANNELS.AGENT_STATE_CHANGED, payload);
  });
  handlers.push(unsubAgentState);

  const unsubAgentDetected = events.on("agent:detected", (payload: unknown) => {
    sendToRenderer(mainWindow, CHANNELS.AGENT_DETECTED, payload);
  });
  handlers.push(unsubAgentDetected);

  const unsubAgentExited = events.on("agent:exited", (payload: unknown) => {
    sendToRenderer(mainWindow, CHANNELS.AGENT_EXITED, payload);
  });
  handlers.push(unsubAgentExited);

  const unsubArtifactDetected = events.on("artifact:detected", (payload: unknown) => {
    sendToRenderer(mainWindow, CHANNELS.ARTIFACT_DETECTED, payload);
  });
  handlers.push(unsubArtifactDetected);

  const unsubTerminalActivity = events.on(
    "terminal:activity",
    (payload: CanopyEventMap["terminal:activity"]) => {
      sendToRenderer(mainWindow, CHANNELS.TERMINAL_ACTIVITY, payload);
    }
  );
  handlers.push(unsubTerminalActivity);

  const handleTerminalSpawn = async (
    _event: Electron.IpcMainInvokeEvent,
    options: TerminalSpawnOptions
  ): Promise<string> => {
    const parseResult = TerminalSpawnOptionsSchema.safeParse(options);
    if (!parseResult.success) {
      console.error("[IPC] Invalid terminal spawn options:", parseResult.error.format());
      throw new Error(`Invalid spawn options: ${parseResult.error.message}`);
    }

    const validatedOptions = parseResult.data;

    const cols = Math.max(1, Math.min(500, Math.floor(validatedOptions.cols) || 80));
    const rows = Math.max(1, Math.min(500, Math.floor(validatedOptions.rows) || 30));

    const type = validatedOptions.type || "terminal";
    const kind = validatedOptions.kind || (validatedOptions.agentId ? "agent" : "terminal");
    const agentId = validatedOptions.agentId;
    const title = validatedOptions.title;
    const worktreeId = validatedOptions.worktreeId;

    const id = validatedOptions.id || crypto.randomUUID();

    const projectPath = projectStore.getCurrentProject()?.path;

    let cwd = validatedOptions.cwd || projectPath || process.env.HOME || os.homedir();

    const fs = await import("fs");
    const path = await import("path");

    const getValidatedFallback = async (): Promise<string> => {
      if (projectPath && path.isAbsolute(projectPath)) {
        try {
          await fs.promises.access(projectPath);
          return projectPath;
        } catch {
          // ignore
        }
      }
      return os.homedir();
    };

    try {
      if (!path.isAbsolute(cwd)) {
        console.warn(`Relative cwd provided: ${cwd}, falling back to project root or home`);
        cwd = await getValidatedFallback();
      }

      await fs.promises.access(cwd);
    } catch (_error) {
      console.warn(`Invalid cwd: ${cwd}, falling back to project root or home`);
      cwd = await getValidatedFallback();
    }

    // Get current project ID for multi-tenancy
    const currentProject = projectStore.getCurrentProject();
    const projectId = currentProject?.id;

    try {
      ptyClient.spawn(id, {
        cwd,
        shell: validatedOptions.shell,
        cols,
        rows,
        env: validatedOptions.env,
        kind,
        type,
        agentId,
        title,
        worktreeId,
        projectId, // Pass project ID for multi-tenancy
      });

      if (validatedOptions.command) {
        const trimmedCommand = validatedOptions.command.trim();

        if (trimmedCommand.length === 0) {
          console.warn("Empty command provided, ignoring");
        } else if (trimmedCommand.includes("\n") || trimmedCommand.includes("\r")) {
          console.error("Multi-line commands not allowed for security, ignoring");
        } else {
          // Note: Commands may contain `;`, `&&`, `||` within properly escaped/quoted arguments
          // (e.g., `claude 'How do I use && in bash?'`). These are safe because the shell
          // treats them as literal characters within quotes, not command separators.
          // The buildAgentCommand function in useAgentLauncher properly escapes all arguments.

          // Wrap agent commands to ensure PTY exits when agent exits
          let finalCommand = trimmedCommand;
          const isAgent = kind === "agent" || Boolean(agentId);
          if (isAgent) {
            if (process.platform === "win32") {
              const shell = (
                validatedOptions.shell ||
                process.env.COMSPEC ||
                "powershell.exe"
              ).toLowerCase();
              if (shell.includes("cmd")) {
                finalCommand = `${trimmedCommand} & exit`;
              } else {
                finalCommand = `${trimmedCommand}; exit`;
              }
            } else {
              finalCommand = `exec ${trimmedCommand}`;
            }
          }

          setTimeout(() => {
            if (ptyClient.hasTerminal(id)) {
              ptyClient.write(id, `${finalCommand}\r`);
            }
          }, 100);
        }
      }

      return id;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to spawn terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_SPAWN, handleTerminalSpawn);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_SPAWN));

  const handleTerminalInput = (_event: Electron.IpcMainEvent, id: string, data: string) => {
    try {
      if (typeof id !== "string" || typeof data !== "string") {
        console.error("Invalid terminal input parameters");
        return;
      }
      ptyClient.write(id, data);
    } catch (error) {
      console.error("Error writing to terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_INPUT, handleTerminalInput);
  handlers.push(() => ipcMain.removeListener(CHANNELS.TERMINAL_INPUT, handleTerminalInput));

  const handleTerminalSubmit = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string,
    text: string
  ) => {
    try {
      if (typeof id !== "string" || typeof text !== "string") {
        throw new Error("Invalid terminal submit parameters");
      }
      ptyClient.submit(id, text);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to submit to terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_SUBMIT, handleTerminalSubmit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_SUBMIT));

  const handleTerminalResize = (_event: Electron.IpcMainEvent, payload: TerminalResizePayload) => {
    try {
      const parseResult = TerminalResizePayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        console.error("[IPC] Invalid terminal resize payload:", parseResult.error.format());
        return;
      }

      const { id, cols, rows } = parseResult.data;
      const clampedCols = Math.max(1, Math.min(500, Math.floor(cols)));
      const clampedRows = Math.max(1, Math.min(500, Math.floor(rows)));

      ptyClient.resize(id, clampedCols, clampedRows);
    } catch (error) {
      console.error("Error resizing terminal:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_RESIZE, handleTerminalResize);
  handlers.push(() => ipcMain.removeListener(CHANNELS.TERMINAL_RESIZE, handleTerminalResize));

  const handleTerminalKill = async (_event: Electron.IpcMainInvokeEvent, id: string) => {
    try {
      if (typeof id !== "string") {
        throw new Error("Invalid terminal ID: must be a string");
      }
      ptyClient.kill(id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to kill terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_KILL, handleTerminalKill);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_KILL));

  const handleTerminalTrash = async (_event: Electron.IpcMainInvokeEvent, id: string) => {
    try {
      if (typeof id !== "string") {
        throw new Error("Invalid terminal ID: must be a string");
      }
      ptyClient.trash(id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to trash terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_TRASH, handleTerminalTrash);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_TRASH));

  const handleTerminalRestore = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string
  ): Promise<boolean> => {
    try {
      if (typeof id !== "string") {
        throw new Error("Invalid terminal ID: must be a string");
      }
      return ptyClient.restore(id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to restore terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_RESTORE, handleTerminalRestore);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_RESTORE));

  const unsubTerminalTrashed = events.on(
    "terminal:trashed",
    (payload: { id: string; expiresAt: number }) => {
      sendToRenderer(mainWindow, CHANNELS.TERMINAL_TRASHED, payload);
    }
  );
  handlers.push(unsubTerminalTrashed);

  const unsubTerminalRestored = events.on("terminal:restored", (payload: { id: string }) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_RESTORED, payload);
  });
  handlers.push(unsubTerminalRestored);

  const handleTerminalFlush = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string
  ): Promise<void> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }
      ptyClient.flushBuffer(id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to flush terminal buffer: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_FLUSH, handleTerminalFlush);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_FLUSH));

  const handleTerminalSetActivityTier = (
    _event: Electron.IpcMainEvent,
    payload: { id: string; tier: PtyHostActivityTier }
  ) => {
    try {
      if (!payload || typeof payload !== "object") {
        return;
      }
      const { id, tier } = payload;
      if (typeof id !== "string" || !id) return;
      const effectiveTier: PtyHostActivityTier = tier === "background" ? "background" : "active";
      ptyClient.setActivityTier(id, effectiveTier);
    } catch (error) {
      console.error("[IPC] Failed to set activity tier:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, handleTerminalSetActivityTier);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, handleTerminalSetActivityTier)
  );

  const handleTerminalWake = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string
  ): Promise<{ state: string | null; warnings?: string[] }> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }
      return await ptyClient.wakeTerminal(id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to wake terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_WAKE, handleTerminalWake);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_WAKE));

  const handleTerminalAcknowledgeData = (
    _event: Electron.IpcMainEvent,
    payload: { id: string; length: number }
  ) => {
    try {
      if (!payload || typeof payload !== "object") {
        return;
      }
      if (typeof payload.id !== "string" || typeof payload.length !== "number") {
        return;
      }
      ptyClient.acknowledgeData(payload.id, payload.length);
    } catch (error) {
      console.error("Error acknowledging terminal data:", error);
    }
  };
  ipcMain.on(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, handleTerminalAcknowledgeData);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, handleTerminalAcknowledgeData)
  );

  // Force resume a paused terminal
  const handleTerminalForceResume = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }
      ptyClient.forceResume(id);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Failed to force resume terminal ${id}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_FORCE_RESUME, handleTerminalForceResume);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_FORCE_RESUME));

  // Forward terminal status events to renderer
  const handleTerminalStatus = (payload: {
    id: string;
    status: string;
    bufferUtilization?: number;
    pauseDuration?: number;
    timestamp: number;
  }) => {
    sendToRenderer(mainWindow, CHANNELS.TERMINAL_STATUS, payload);
  };
  ptyClient.on("terminal-status", handleTerminalStatus);
  handlers.push(() => ptyClient.off("terminal-status", handleTerminalStatus));

  // Query terminals for a specific project
  const handleTerminalGetForProject = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ) => {
    try {
      if (typeof projectId !== "string" || !projectId) {
        throw new Error("Invalid project ID: must be a non-empty string");
      }

      const terminalIds = await ptyClient.getTerminalsForProjectAsync(projectId);

      // Get terminal info for each ID
      const terminals = [];
      for (const id of terminalIds) {
        const terminal = await ptyClient.getTerminalAsync(id);
        if (terminal) {
          terminals.push({
            id: terminal.id,
            projectId: terminal.projectId,
            type: terminal.type,
            title: terminal.title,
            cwd: terminal.cwd,
            worktreeId: terminal.worktreeId,
            agentState: terminal.agentState,
            spawnedAt: terminal.spawnedAt,
          });
        }
      }

      console.log(
        `[IPC] terminal:getForProject(${projectId}): found ${terminals.length} terminals`
      );
      return terminals;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get terminals for project: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_FOR_PROJECT, handleTerminalGetForProject);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_FOR_PROJECT));

  // Reconnect to an existing terminal (verify it exists)
  const handleTerminalReconnect = async (
    _event: Electron.IpcMainInvokeEvent,
    terminalId: string
  ) => {
    try {
      if (typeof terminalId !== "string" || !terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const terminal = await ptyClient.getTerminalAsync(terminalId);

      if (!terminal) {
        console.warn(`[IPC] terminal:reconnect: Terminal ${terminalId} not found`);
        return { exists: false, error: "Terminal not found in backend" };
      }

      console.log(`[IPC] terminal:reconnect: Reconnecting to ${terminalId}`);

      return {
        exists: true,
        id: terminal.id,
        type: terminal.type,
        cwd: terminal.cwd,
        agentState: terminal.agentState,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to reconnect to terminal: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_RECONNECT, handleTerminalReconnect);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_RECONNECT));

  // Replay terminal history (uses existing replayHistory from Phase 2)
  const handleTerminalReplayHistory = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { terminalId: string; maxLines?: number }
  ) => {
    try {
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      if (typeof payload.terminalId !== "string" || !payload.terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const maxLines = payload.maxLines ?? 100;

      const replayed = await ptyClient.replayHistoryAsync(payload.terminalId, maxLines);

      console.log(
        `[IPC] terminal:replayHistory(${payload.terminalId}): replayed ${replayed} lines`
      );
      return { replayed };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to replay terminal history: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_REPLAY_HISTORY, handleTerminalReplayHistory);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_REPLAY_HISTORY));

  // Get serialized terminal state for fast restoration
  const handleTerminalGetSerializedState = async (
    _event: Electron.IpcMainInvokeEvent,
    terminalId: string
  ): Promise<string | null> => {
    try {
      if (typeof terminalId !== "string" || !terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const serializedState = await ptyClient.getSerializedStateAsync(terminalId);

      if (process.env.CANOPY_VERBOSE) {
        console.log(
          `[IPC] terminal:getSerializedState(${terminalId}): ${serializedState ? `${serializedState.length} bytes` : "null"}`
        );
      }
      return serializedState;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get serialized terminal state: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, handleTerminalGetSerializedState);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_SERIALIZED_STATE));

  // Get terminal information for diagnostic display
  const handleTerminalGetInfo = async (
    _event: Electron.IpcMainInvokeEvent,
    id: string
  ): Promise<import("../../../shared/types/ipc.js").TerminalInfoPayload> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const terminalInfo = await ptyClient.getTerminalInfo(id);

      if (!terminalInfo) {
        throw new Error(`Terminal ${id} not found`);
      }

      return terminalInfo;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get terminal info: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_INFO, handleTerminalGetInfo);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_INFO));

  // Get SharedArrayBuffer for zero-copy terminal I/O (visual rendering)
  const handleTerminalGetSharedBuffer = async (): Promise<SharedArrayBuffer | null> => {
    try {
      return ptyClient.getSharedBuffer();
    } catch (error) {
      console.warn("[IPC] Failed to get shared buffer:", error);
      return null;
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_SHARED_BUFFER, handleTerminalGetSharedBuffer);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_SHARED_BUFFER));

  // Get SharedArrayBuffer for semantic analysis (Web Worker)
  const handleTerminalGetAnalysisBuffer = async (): Promise<SharedArrayBuffer | null> => {
    try {
      return ptyClient.getAnalysisBuffer();
    } catch (error) {
      console.warn("[IPC] Failed to get analysis buffer:", error);
      return null;
    }
  };
  ipcMain.handle(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER, handleTerminalGetAnalysisBuffer);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER));

  const handleArtifactSaveToFile = async (
    _event: Electron.IpcMainInvokeEvent,
    options: unknown
  ): Promise<{ filePath: string; success: boolean } | null> => {
    try {
      if (
        typeof options !== "object" ||
        options === null ||
        !("content" in options) ||
        typeof (options as Record<string, unknown>).content !== "string"
      ) {
        throw new Error("Invalid saveToFile payload: missing or invalid content");
      }

      const { content, suggestedFilename, cwd } = options as {
        content: string;
        suggestedFilename?: string;
        cwd?: string;
      };

      if (content.length > 10 * 1024 * 1024) {
        throw new Error("Artifact content exceeds maximum size (10MB)");
      }

      let safeCwd = os.homedir();
      if (cwd && typeof cwd === "string") {
        const fs = await import("fs/promises");
        try {
          const resolvedCwd = path.resolve(cwd);
          const stat = await fs.stat(resolvedCwd);
          if (stat.isDirectory()) {
            safeCwd = resolvedCwd;
          }
        } catch {
          safeCwd = os.homedir();
        }
      }

      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Save Artifact",
        defaultPath: suggestedFilename
          ? path.join(safeCwd, path.basename(suggestedFilename))
          : path.join(safeCwd, "artifact.txt"),
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });

      if (result.canceled || !result.filePath) {
        return null;
      }

      const fs = await import("fs/promises");
      await fs.writeFile(result.filePath, content, "utf-8");

      return {
        filePath: result.filePath,
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Artifact] Failed to save to file:", errorMessage);
      throw new Error(`Failed to save artifact: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.ARTIFACT_SAVE_TO_FILE, handleArtifactSaveToFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.ARTIFACT_SAVE_TO_FILE));

  const handleArtifactApplyPatch = async (
    _event: Electron.IpcMainInvokeEvent,
    options: unknown
  ): Promise<{ success: boolean; error?: string; modifiedFiles?: string[] }> => {
    try {
      if (
        typeof options !== "object" ||
        options === null ||
        !("patchContent" in options) ||
        !("cwd" in options) ||
        typeof (options as Record<string, unknown>).patchContent !== "string" ||
        typeof (options as Record<string, unknown>).cwd !== "string"
      ) {
        throw new Error("Invalid applyPatch payload: missing or invalid patchContent/cwd");
      }

      const { patchContent, cwd } = options as { patchContent: string; cwd: string };

      if (patchContent.length > 5 * 1024 * 1024) {
        throw new Error("Patch content exceeds maximum size (5MB)");
      }

      const fs = await import("fs/promises");
      let resolvedCwd: string;
      try {
        resolvedCwd = path.resolve(cwd);

        const stat = await fs.stat(resolvedCwd);
        if (!stat.isDirectory()) {
          return {
            success: false,
            error: "Provided cwd is not a directory",
          };
        }

        const gitPath = path.join(resolvedCwd, ".git");
        try {
          await fs.stat(gitPath);
        } catch {
          return {
            success: false,
            error: "Provided cwd is not a git repository",
          };
        }

        if (workspaceClient) {
          const states = await workspaceClient.getAllStatesAsync();
          const isValidWorktree = states.some(
            (wt: { path: string }) => path.resolve(wt.path) === resolvedCwd
          );

          if (!isValidWorktree) {
            return {
              success: false,
              error: "Directory is not a known worktree",
            };
          }
        }
      } catch (error) {
        return {
          success: false,
          error: `Invalid cwd: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const tmpPatchPath = path.join(os.tmpdir(), `canopy-patch-${Date.now()}.patch`);
      await fs.writeFile(tmpPatchPath, patchContent, "utf-8");

      try {
        const { execa } = await import("execa");
        await execa("git", ["apply", tmpPatchPath], { cwd: resolvedCwd });

        const modifiedFiles: string[] = [];
        const lines = patchContent.split("\n");
        for (const line of lines) {
          if (line.startsWith("+++")) {
            const match = line.match(/\+\+\+ b\/(.+)/);
            if (match) {
              modifiedFiles.push(match[1]);
            }
          }
        }

        return {
          success: true,
          modifiedFiles,
        };
      } finally {
        await fs.unlink(tmpPatchPath).catch(() => {});
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Artifact] Failed to apply patch:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  };
  ipcMain.handle(CHANNELS.ARTIFACT_APPLY_PATCH, handleArtifactApplyPatch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.ARTIFACT_APPLY_PATCH));

  return () => handlers.forEach((cleanup) => cleanup());
}
