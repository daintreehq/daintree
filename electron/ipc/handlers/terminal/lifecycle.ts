/**
 * Terminal lifecycle handlers - spawn, kill, trash, restore.
 */

import crypto from "crypto";
import os from "os";
import { z } from "zod";
import { CHANNELS } from "../../channels.js";
import {
  waitForRateLimitSlot,
  consumeRestoreQuota,
  typedHandle,
  typedHandleValidated,
} from "../../utils.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { mcpServerService } from "../../../services/McpServerService.js";
import { mcpPaneConfigService } from "../../../services/McpPaneConfigService.js";
import { helpSessionService } from "../../../services/HelpSessionService.js";
import type { HandlerDependencies } from "../../types.js";
import { TerminalSpawnOptionsSchema } from "../../../schemas/ipc.js";
import { resolveDaintreeMcpTier } from "../../../../shared/types/project.js";
import { DEFAULT_DANGEROUS_ARGS } from "../../../../shared/types/agentSettings.js";

type ValidatedTerminalSpawnOptions = z.output<typeof TerminalSpawnOptionsSchema>;
import {
  listAgentSessions,
  clearAgentSessions,
} from "../../../services/pty/agentSessionHistory.js";
import { getDefaultShell } from "../../../services/pty/terminalShell.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function supportsCommandLaunchShell(shell: string): boolean {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return (
    name === "zsh" ||
    name === "bash" ||
    name === "sh" ||
    name.endsWith("zsh") ||
    name.endsWith("bash") ||
    name.endsWith("sh")
  );
}

// Trust boundary: `command` is interpolated raw into the shell script below.
// Shell metacharacters (pipes, redirects, env-var expansion, $()) are
// intentional — QuickRun and resource-connect commands rely on them. Defenses
// upstream of this point: (1) TerminalSpawnOptionsSchema rejects control
// characters at the IPC boundary; (2) the multiline guard in the spawn handler
// drops embedded \n / \r as defense-in-depth; (3) WorktreeLifecycleService.
// substituteVariables shell-quotes every templated fragment via
// shellEscapeValue before it reaches the command field. Anyone adding a new
// call site that interpolates user-controlled data into `command` MUST quote
// the substituted fragment, not rely on this layer.
function buildCommandLaunchShell(
  command: string,
  configuredShell: string | undefined
): { shell: string; args: string[] } | null {
  if (process.platform === "win32" || command.length === 0) {
    return null;
  }

  const shell = configuredShell || getDefaultShell();
  if (!supportsCommandLaunchShell(shell)) {
    return null;
  }

  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const execInteractiveShell =
    name.includes("zsh") || name.includes("bash")
      ? `exec ${shellQuote(shell)} -l`
      : `exec ${shellQuote(shell)}`;

  // Run the command as interactive shell startup work instead of typing it into
  // the PTY. This prevents the tail of long absolute launch commands from being
  // echoed while preserving job control: zsh/bash only move the launched CLI
  // into the PTY foreground process group when the shell is interactive. The
  // foreground-pgid detector relies on that, and agent CLIs rely on it for raw
  // input. The wrapper shell traps SIGINT so Ctrl-C reaches the foreground
  // agent without killing the wrapper before it can exec the follow-up shell.
  // Use a no-op trap rather than SIG_IGN so child CLIs don't inherit ignored
  // SIGINT.
  const script = `trap : INT\n${command}\ntrap - INT\n${execInteractiveShell}`;
  const args =
    name.includes("zsh") || name.includes("bash") ? ["-lic", script] : ["-i", "-c", script];

  return { shell, args };
}

export function registerTerminalLifecycleHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }
  const handlers: Array<() => void> = [];

  const handleTerminalSpawn = async (
    validatedOptions: ValidatedTerminalSpawnOptions
  ): Promise<string> => {
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

    const trimmedCommand = validatedOptions.command?.trim() || "";
    const hasMultilineCommand =
      trimmedCommand.length > 0 && (trimmedCommand.includes("\n") || trimmedCommand.includes("\r"));

    if (hasMultilineCommand) {
      console.error("Multi-line commands not allowed for security, ignoring");
    }
    let safeCommand = hasMultilineCommand ? "" : trimmedCommand;
    let spawnEnv: Record<string, string> | undefined = validatedOptions.env;

    // Help-assistant launches arrive with a pre-provisioned session dir whose
    // .mcp.json is already in cwd. The renderer threads DAINTREE_MCP_TOKEN
    // through spawnEnv; presence of a valid token signals a help launch.
    // Skip per-pane MCP config injection (the session dir owns it) and append
    // --strict-mcp-config so Claude Code ignores any global ~/.claude config.
    // When the session was provisioned with skipPermissions, also append the
    // dangerous flag so the agent runs without the per-tool prompt.
    const helpToken = spawnEnv?.DAINTREE_MCP_TOKEN ?? "";
    const helpTier = helpToken ? helpSessionService.validateToken(helpToken) : false;
    const isHelpLaunch = helpTier !== false && launchAgentId === "claude" && safeCommand.length > 0;

    if (isHelpLaunch) {
      if (!safeCommand.includes("--strict-mcp-config")) {
        safeCommand = `${safeCommand} --strict-mcp-config`;
      }
      if (helpTier === "system") {
        const dangerous = DEFAULT_DANGEROUS_ARGS[launchAgentId];
        if (dangerous && !safeCommand.includes(dangerous)) {
          safeCommand = `${safeCommand} ${dangerous}`;
        }
      }
    } else if (
      launchAgentId === "claude" &&
      safeCommand.length > 0 &&
      projectId &&
      mcpServerService.isRunning
    ) {
      // Daintree MCP injection for normal Claude Code agent launches.
      // Mints a per-pane bearer token, writes a managed --mcp-config JSON under
      // userData, and injects the flag into the command + the token into env.
      // Token is revoked and the file deleted on PTY exit (see registerTerminalEventHandlers).
      try {
        const projSettings = await projectStore.getProjectSettings(projectId);
        const tier = resolveDaintreeMcpTier(projSettings);
        if (tier !== "off") {
          const port = mcpServerService.currentPort;
          if (port) {
            const { configPath, token } = await mcpPaneConfigService.preparePaneConfig({
              paneId: id,
              port,
              tier,
            });
            safeCommand = `${safeCommand} --mcp-config ${shellQuote(configPath)}`;
            spawnEnv = { ...(spawnEnv ?? {}), DAINTREE_MCP_TOKEN: token };
          }
        }
      } catch (mcpErr) {
        console.error(
          "[TerminalSpawn] Failed to prepare Daintree MCP config; continuing without MCP injection:",
          mcpErr
        );
      }
    }

    // Resolve shell and args: project overrides > spawn options > defaults.
    // For command launches on POSIX, run the command through the shell's
    // startup script instead of echoing it into the PTY.
    const resolvedShell = validatedOptions.shell || projectShell;
    const commandLaunchShell = buildCommandLaunchShell(safeCommand, resolvedShell);
    const resolvedArgs = commandLaunchShell ? commandLaunchShell.args : projectArgs;
    const spawnShell = commandLaunchShell ? commandLaunchShell.shell : resolvedShell;

    try {
      // Every terminal is an interactive shell. Agent launches inject their
      // command after the shell's first prompt renders — never `exec`'d over
      // the shell, so when the agent exits the shell reclaims the foreground.
      // SIGINT routes to the agent (the foreground process group) via the
      // kernel's TTY line discipline; the shell stays pristine.
      ptyClient.spawn(id, {
        cwd,
        shell: spawnShell,
        args: resolvedArgs,
        cols,
        rows,
        command: safeCommand || undefined,
        env: spawnEnv,
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
        agentPresetColor: validatedOptions.agentPresetColor,
        originalAgentPresetId:
          validatedOptions.originalAgentPresetId ?? validatedOptions.agentPresetId,
      });

      if (safeCommand.length > 0 && !commandLaunchShell) {
        // Execute immediately. node-pty queues the write against the spawned
        // shell, so users do not stare at a blank prompt while we wait for RC
        // files/prompt detection. The shell still remains the parent process;
        // when the command exits, the terminal returns to a normal shell.
        if (ptyClient.hasTerminal(id)) {
          ptyClient.write(id, `${safeCommand}\r`);
        }
      }

      return id;
    } catch (error) {
      // If we minted an MCP pane config above and the PTY spawn never landed,
      // revoke it now so we don't leak per-pane tokens or config files.
      mcpPaneConfigService.revokePaneConfig(id).catch(() => {
        // best-effort cleanup
      });
      const errorMessage = formatErrorMessage(error, "Failed to spawn terminal");
      throw new Error(`Failed to spawn terminal: ${errorMessage}`);
    }
  };
  handlers.push(
    typedHandleValidated(CHANNELS.TERMINAL_SPAWN, TerminalSpawnOptionsSchema, handleTerminalSpawn)
  );

  const handleTerminalKill = async (id: string) => {
    try {
      if (typeof id !== "string") {
        throw new Error("Invalid terminal ID: must be a string");
      }
      ptyClient.kill(id);
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to kill terminal");
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
      const errorMessage = formatErrorMessage(error, "Failed to trash terminal");
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
      const errorMessage = formatErrorMessage(error, "Failed to restore terminal");
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
