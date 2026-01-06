/**
 * Terminal lifecycle handlers - spawn, kill, trash, restore.
 */

import { ipcMain } from "electron";
import crypto from "crypto";
import os from "os";
import { CHANNELS } from "../../channels.js";
import { projectStore } from "../../../services/ProjectStore.js";
import type { HandlerDependencies } from "../../types.js";
import type { TerminalSpawnOptions } from "../../../types/index.js";
import { TerminalSpawnOptionsSchema } from "../../../schemas/ipc.js";

export function registerTerminalLifecycleHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
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

    const cols = Math.max(1, Math.min(500, Math.floor(validatedOptions.cols) || 80));
    const rows = Math.max(1, Math.min(500, Math.floor(validatedOptions.rows) || 30));

    const type = validatedOptions.type || "terminal";

    // Normalize kind and agentId from type when type is a registered agent
    // This ensures agent terminals are consistently identified across all layers
    // Override kind when type is an agent to prevent mixed metadata
    const { isRegisteredAgent } = await import("../../../shared/config/agentRegistry.js");
    const isAgentType = type !== "terminal" && isRegisteredAgent(type);

    const kind = isAgentType ? "agent" : (validatedOptions.kind || (validatedOptions.agentId ? "agent" : "terminal"));
    const agentId = validatedOptions.agentId || (isAgentType ? type : undefined);
    const title = validatedOptions.title;
    const worktreeId = validatedOptions.worktreeId;

    const id = validatedOptions.id || crypto.randomUUID();

    // Snapshot current project ONCE to avoid race conditions during async filesystem checks
    const currentProject = projectStore.getCurrentProject();
    const projectId = currentProject?.id;
    const projectPath = currentProject?.path;

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

    // Debug: log projectId assignment
    if (process.env.CANOPY_VERBOSE) {
      console.log(`[TerminalSpawn] Spawning terminal ${id.slice(0, 8)}:`, {
        projectId: projectId?.slice(0, 8) ?? "undefined",
        projectName: currentProject?.name ?? "none",
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
        projectId,
        restore: validatedOptions.restore,
      });

      if (validatedOptions.command) {
        const trimmedCommand = validatedOptions.command.trim();

        if (trimmedCommand.length === 0) {
          console.warn("Empty command provided, ignoring");
        } else if (trimmedCommand.includes("\n") || trimmedCommand.includes("\r")) {
          console.error("Multi-line commands not allowed for security, ignoring");
        } else {
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

  return () => handlers.forEach((cleanup) => cleanup());
}
