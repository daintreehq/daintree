/**
 * Terminal lifecycle handlers - spawn, kill, trash, restore.
 */

import crypto from "crypto";
import os from "os";
import { CHANNELS } from "../../channels.js";
import { waitForRateLimitSlot, consumeRestoreQuota, typedHandle } from "../../utils.js";
import { projectStore } from "../../../services/ProjectStore.js";
import type { HandlerDependencies } from "../../types.js";
import type { TerminalSpawnOptions } from "../../../types/index.js";
import { TerminalSpawnOptionsSchema } from "../../../schemas/ipc.js";
import {
  listAgentSessions,
  clearAgentSessions,
} from "../../../services/pty/agentSessionHistory.js";
import { waitForShellReady } from "./shellReady.js";

export function registerTerminalLifecycleHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }
  const handlers: Array<() => void> = [];

  const handleTerminalSpawn = async (options: TerminalSpawnOptions): Promise<string> => {
    const parseResult = TerminalSpawnOptionsSchema.safeParse(options);
    if (!parseResult.success) {
      console.error("[IPC] Invalid terminal spawn options:", parseResult.error.format());
      throw new Error(`Invalid spawn options: ${parseResult.error.message}`);
    }

    const validatedOptions = parseResult.data;

    const bypassedRateLimit = validatedOptions.restore === true && consumeRestoreQuota();
    if (!bypassedRateLimit) {
      await waitForRateLimitSlot("terminalSpawn", 1_000);
    }

    const cols = Math.max(1, Math.min(500, Math.floor(validatedOptions.cols) || 80));
    const rows = Math.max(1, Math.min(500, Math.floor(validatedOptions.rows) || 30));

    const kind = "terminal";
    const launchAgentId = validatedOptions.launchAgentId;
    const title = validatedOptions.title;

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

    // Fetch project-level terminal overrides when there's no agent launch
    // hint. Agent launches intentionally use the default shell configuration
    // (user shell + default args) to keep behaviour predictable — project
    // overrides can shape plain-shell UX without leaking into agent launches.
    let projectShell: string | undefined;
    let projectArgs: string[] | undefined;
    let projectCwd: string | undefined;
    if (projectId && !launchAgentId) {
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
    if (process.env.DAINTREE_VERBOSE) {
      console.log(`[TerminalSpawn] Spawning terminal ${id.slice(0, 8)}:`, {
        projectId: projectId?.slice(0, 8) ?? "undefined",
        projectName: resolvedProject?.name ?? "none",
        kind,
        launchAgentId,
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

    const trimmedCommand = validatedOptions.command?.trim() || "";
    const hasMultilineCommand =
      trimmedCommand.length > 0 && (trimmedCommand.includes("\n") || trimmedCommand.includes("\r"));

    if (hasMultilineCommand) {
      console.error("Multi-line commands not allowed for security, ignoring");
    }
    const safeCommand = hasMultilineCommand ? "" : trimmedCommand;

    try {
      // Every terminal is an interactive shell. Agent launches inject their
      // command after the shell's first prompt renders — never `exec`'d over
      // the shell, so when the agent exits the shell reclaims the foreground.
      // SIGINT routes to the agent (the foreground process group) via the
      // kernel's TTY line discipline; the shell stays pristine.
      ptyClient.spawn(id, {
        cwd,
        shell: resolvedShell,
        args: resolvedArgs,
        cols,
        rows,
        env: validatedOptions.env,
        kind,
        launchAgentId,
        title,
        projectId,
        restore: validatedOptions.restore,
        isEphemeral: validatedOptions.isEphemeral,
        agentLaunchFlags: validatedOptions.agentLaunchFlags,
        agentModelId: validatedOptions.agentModelId,
        worktreeId: validatedOptions.worktreeId,
        agentPresetId: validatedOptions.agentPresetId,
        originalAgentPresetId:
          validatedOptions.originalAgentPresetId ?? validatedOptions.agentPresetId,
      });

      if (safeCommand.length > 0) {
        // Wait for the shell to print its first prompt and go quiet before
        // injecting the command — a fixed delay races with slow RC files
        // (oh-my-zsh, p10k, nvm, direnv). Fire-and-forget so the IPC
        // response returns immediately; `hasTerminal` guards against the
        // terminal being killed mid-wait.
        //
        // No clear-screen preamble is written. Users see their shell prompt
        // momentarily before the agent takes over — that is the honest
        // "first-class terminal" UX and it eliminates the escape-garbage
        // some shells echoed when the preamble's `printf` text was visible
        // before execution.
        void waitForShellReady(ptyClient, id).then(() => {
          if (!ptyClient.hasTerminal(id)) return;
          ptyClient.write(id, `${safeCommand}\r`);
        });
      }

      return id;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to spawn terminal: ${errorMessage}`);
    }
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_SPAWN, handleTerminalSpawn));

  const handleTerminalKill = async (id: string) => {
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
  handlers.push(typedHandle(CHANNELS.TERMINAL_KILL, handleTerminalKill));

  const handleTerminalGracefulKill = async (id: string): Promise<string | null> => {
    if (typeof id !== "string") {
      throw new Error("Invalid terminal ID: must be a string");
    }
    return ptyClient.gracefulKill(id);
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_GRACEFUL_KILL, handleTerminalGracefulKill));

  const handleTerminalTrash = async (id: string) => {
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
  handlers.push(typedHandle(CHANNELS.TERMINAL_TRASH, handleTerminalTrash));

  const handleTerminalRestore = async (id: string): Promise<boolean> => {
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
  handlers.push(typedHandle(CHANNELS.TERMINAL_RESTORE, handleTerminalRestore));

  const handleTerminalRestartService = async () => {
    ptyClient.manualRestart();
  };
  handlers.push(typedHandle(CHANNELS.TERMINAL_RESTART_SERVICE, handleTerminalRestartService));

  const handleAgentSessionList = async (payload: { worktreeId?: string }) => {
    const { app } = await import("electron");
    return listAgentSessions(payload?.worktreeId, app.getPath("userData"));
  };
  handlers.push(typedHandle(CHANNELS.AGENT_SESSION_LIST, handleAgentSessionList));

  const handleAgentSessionClear = async (payload: { worktreeId?: string }) => {
    const { app } = await import("electron");
    await clearAgentSessions(payload?.worktreeId, app.getPath("userData"));
  };
  handlers.push(typedHandle(CHANNELS.AGENT_SESSION_CLEAR, handleAgentSessionClear));

  return () => handlers.forEach((cleanup) => cleanup());
}
