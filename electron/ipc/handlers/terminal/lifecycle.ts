/**
 * Terminal lifecycle handlers - spawn, kill, trash, restore.
 */

import { ipcMain } from "electron";
import crypto from "crypto";
import os from "os";
import { CHANNELS } from "../../channels.js";
import { waitForRateLimitSlot, consumeRestoreQuota } from "../../utils.js";
import { projectStore } from "../../../services/ProjectStore.js";
import type { HandlerDependencies } from "../../types.js";
import type { TerminalSpawnOptions } from "../../../types/index.js";
import { TerminalSpawnOptionsSchema } from "../../../schemas/ipc.js";
import { getDefaultShell } from "../../../services/pty/terminalShell.js";

export const COMMAND_DELAY_MS = 100;

export function registerTerminalLifecycleHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }
  const handlers: Array<() => void> = [];

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

    const bypassedRateLimit = validatedOptions.restore === true && consumeRestoreQuota();
    if (!bypassedRateLimit) {
      await waitForRateLimitSlot("terminalSpawn", 10, 30_000);
    }

    const cols = Math.max(1, Math.min(500, Math.floor(validatedOptions.cols) || 80));
    const rows = Math.max(1, Math.min(500, Math.floor(validatedOptions.rows) || 30));

    const type = validatedOptions.type || "terminal";

    // Normalize kind and agentId from type when type is a registered agent
    // This ensures agent terminals are consistently identified across all layers
    // Override kind when type is an agent to prevent mixed metadata
    const { isRegisteredAgent } = await import("../../../../shared/config/agentRegistry.js");
    const isAgentType = type !== "terminal" && isRegisteredAgent(type);

    const kind = isAgentType
      ? "agent"
      : validatedOptions.kind || (validatedOptions.agentId ? "agent" : "terminal");
    const agentId = validatedOptions.agentId || (isAgentType ? type : undefined);
    const title = validatedOptions.title;
    const worktreeId = validatedOptions.worktreeId;

    const id = validatedOptions.id || crypto.randomUUID();

    // Prefer explicit projectId from renderer (captured at action time) over global state.
    // Falls back to global state for backward compatibility (e.g., agent/workflow spawns).
    let resolvedProject = validatedOptions.projectId
      ? projectStore.getProjectById(validatedOptions.projectId)
      : null;
    if (!resolvedProject) {
      if (validatedOptions.projectId) {
        console.warn(
          `[TerminalSpawn] Explicit projectId ${validatedOptions.projectId.slice(0, 8)} not found, falling back to current project`
        );
      }
      resolvedProject = projectStore.getCurrentProject();
    }
    const projectId = resolvedProject?.id;
    const projectPath = resolvedProject?.path;

    // Fetch project-level terminal overrides for non-agent terminals
    let projectShell: string | undefined;
    let projectArgs: string[] | undefined;
    let projectCwd: string | undefined;
    if (projectId && kind !== "agent") {
      const projSettings = await projectStore.getProjectSettings(projectId);
      const ts = projSettings.terminalSettings;
      if (ts) {
        if (!validatedOptions.shell && ts.shell) {
          projectShell = ts.shell;
        }
        if (ts.shellArgs) {
          projectArgs = ts.shellArgs;
        }
        if (!validatedOptions.cwd && ts.defaultWorkingDirectory) {
          projectCwd = ts.defaultWorkingDirectory;
        }
      }
    }

    let cwd = validatedOptions.cwd || projectCwd || projectPath || os.homedir();

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

    // Debug: log projectId assignment
    if (process.env.CANOPY_VERBOSE) {
      console.log(`[TerminalSpawn] Spawning terminal ${id.slice(0, 8)}:`, {
        projectId: projectId?.slice(0, 8) ?? "undefined",
        projectName: resolvedProject?.name ?? "none",
        kind,
        type,
      });
    }

    // Warn if spawning without projectId - this will cause stats issues
    if (!projectId) {
      console.warn(
        `[TerminalSpawn] Terminal ${id.slice(0, 8)} spawned without projectId - ` +
          "stats will not track this terminal for any project"
      );
    }

    // Resolve shell and args: project overrides > spawn options > defaults
    const resolvedShell = validatedOptions.shell || projectShell;
    const resolvedArgs = projectArgs;

    // For agent terminals on Unix with a command, pass it via shell -c flag
    // instead of writing to stdin. This avoids all shell init noise (echoed
    // commands, prompts, stty tricks) since the shell runs the command directly
    // after sourcing rc files, with no interactive prompt.
    const trimmedCommand = validatedOptions.command?.trim() || "";
    const isAgent = kind === "agent" || Boolean(agentId);
    const useShellExec = isAgent && trimmedCommand.length > 0 && process.platform !== "win32";

    let spawnArgs = resolvedArgs;
    if (useShellExec) {
      if (trimmedCommand.includes("\n") || trimmedCommand.includes("\r")) {
        console.error("Multi-line commands not allowed for security, ignoring");
      } else {
        const agentCommand = `exec ${trimmedCommand}`;
        const shellToUse = (resolvedShell || getDefaultShell()).toLowerCase();
        if (shellToUse.includes("zsh") || shellToUse.includes("bash")) {
          // -l: login shell (sources .zprofile/.bash_profile)
          // -i: interactive (sources .zshrc/.bashrc for PATH setup like nvm)
          // -c: run command then exit (no prompt displayed)
          spawnArgs = ["-lic", agentCommand];
        } else {
          spawnArgs = ["-c", agentCommand];
        }
      }
    }

    try {
      ptyClient.spawn(id, {
        cwd,
        shell: resolvedShell,
        args: spawnArgs,
        cols,
        rows,
        env: validatedOptions.env,
        kind,
        type,
        agentId,
        title,
        worktreeId,
        projectId,
        restore: validatedOptions.restore,
        isEphemeral: validatedOptions.isEphemeral,
      });

      // For non-agent terminals (or Windows agent terminals), write command to stdin
      if (trimmedCommand.length > 0 && !useShellExec) {
        if (trimmedCommand.includes("\n") || trimmedCommand.includes("\r")) {
          console.error("Multi-line commands not allowed for security, ignoring");
        } else {
          let finalCommand = trimmedCommand;
          if (isAgent) {
            if (process.platform === "win32") {
              const shell = (resolvedShell || getDefaultShell()).toLowerCase();
              const shellBasename = shell.split(/[\\/]/).pop() ?? shell;
              if (shellBasename === "cmd.exe" || shellBasename === "cmd") {
                finalCommand = `${trimmedCommand} & exit`;
              } else {
                finalCommand = `${trimmedCommand}; exit`;
              }
            }
          }

          setTimeout(() => {
            if (ptyClient.hasTerminal(id)) {
              ptyClient.write(id, `${finalCommand}\r`);
            }
          }, COMMAND_DELAY_MS);
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

  const handleTerminalRestartService = async () => {
    ptyClient.manualRestart();
  };
  ipcMain.handle(CHANNELS.TERMINAL_RESTART_SERVICE, handleTerminalRestartService);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_RESTART_SERVICE));

  return () => handlers.forEach((cleanup) => cleanup());
}
