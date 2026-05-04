import { mkdir, writeFile } from "fs/promises";
import { join as pathJoin } from "path";
import type { WorkspaceHostEvent } from "../../shared/types/workspace-host.js";
import type { WorktreeResourceStatus } from "../../shared/types/worktree.js";
import { WorktreeMonitor } from "./WorktreeMonitor.js";
import { WorktreeLifecycleService } from "./WorktreeLifecycleService.js";
import { applyResourceConfigToMonitor } from "./resourceConfigHelpers.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

/**
 * Narrow context interface that the executor needs from the owning
 * `WorkspaceService`. Mutable workspace state (e.g. `projectRootPath`) is
 * exposed through getters so the executor always reads the current value
 * rather than capturing it at construction.
 */
export interface ResourceActionContext {
  getProjectRootPath(): string | null;
  getMonitor(worktreeId: string): WorktreeMonitor | undefined;
  getProjectEnvVars(): Record<string, string>;
  emitUpdate(monitor: WorktreeMonitor): void;
  sendEvent(event: WorkspaceHostEvent): void;
  readonly lifecycleService: WorktreeLifecycleService;
}

/**
 * Encapsulates resource-action execution (`provision` / `teardown` /
 * `resume` / `pause` / `status`).
 *
 * The owning `WorkspaceService` retains the per-worktree `PQueue` and
 * `AbortController` Maps (an existing test inspects them via bracket
 * notation) and only delegates the execution body to this class.
 */
export class ResourceActionExecutor {
  constructor(private readonly ctx: ResourceActionContext) {}

  async execute(
    requestId: string,
    worktreeId: string,
    action: "provision" | "teardown" | "resume" | "pause" | "status",
    environmentId: string | undefined,
    signal: AbortSignal
  ): Promise<{ success: boolean; error?: string; output?: string }> {
    const monitor = this.ctx.getMonitor(worktreeId);
    const projectRootPath = this.ctx.getProjectRootPath();
    if (!monitor || !projectRootPath) {
      return { success: false, error: "Worktree not found" };
    }

    if (signal.aborted) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "Aborted",
      });
      return { success: false, error: "Aborted" };
    }

    const config = await this.ctx.lifecycleService.loadConfig(monitor.path, projectRootPath);

    // Resolve resource config: prefer resources (plural) over resource (singular)
    let resourceConfig = config?.resource;
    if (config?.resources) {
      if (environmentId && config.resources[environmentId]) {
        resourceConfig = config.resources[environmentId];
      } else if (config.resources["default"]) {
        resourceConfig = config.resources["default"];
      } else {
        const keys = Object.keys(config.resources);
        if (keys.length > 0) {
          resourceConfig = config.resources[keys[0]];
        }
      }
    }

    // Fallback: resolve from project settings resourceEnvironments
    if (!resourceConfig) {
      const envKey = monitor.worktreeMode;
      if (envKey && envKey !== "local") {
        const envs =
          await this.ctx.lifecycleService.loadProjectResourceEnvironments(projectRootPath);
        resourceConfig = envs?.[envKey] ?? undefined;
      }
    }

    if (!resourceConfig) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: "No resource config found",
      });
      return { success: false, error: "No resource config found" };
    }

    const vars = this.ctx.lifecycleService.buildVariables(
      monitor.path,
      projectRootPath,
      monitor.name,
      monitor.branch
    );
    const sub = (cmd: string) => this.ctx.lifecycleService.substituteVariables(cmd, vars);

    applyResourceConfigToMonitor(monitor, resourceConfig, sub);

    const env = this.ctx.lifecycleService.buildEnv(
      monitor.path,
      projectRootPath,
      monitor.name,
      monitor.branch,
      {
        provider: resourceConfig.provider,
        endpoint: monitor.resourceStatus?.endpoint,
        lastOutput: monitor.resourceStatus?.lastOutput,
      },
      this.ctx.getProjectEnvVars()
    );

    // Idempotent provision: route to resume when paused, no-op when already running.
    let effectiveAction = action;
    if (action === "provision") {
      const currentStatus = monitor.resourceStatus?.lastStatus?.toLowerCase();
      if (
        currentStatus === "ready" ||
        currentStatus === "running" ||
        currentStatus === "healthy" ||
        currentStatus === "up"
      ) {
        console.log(
          `[WorktreeLifecycle] Provision no-op for worktree ${worktreeId}: already ${currentStatus}`
        );
        this.ctx.sendEvent({
          type: "resource-action-result",
          requestId,
          success: true,
          output: `Resource is already ${currentStatus}`,
        });
        return { success: true, output: `Resource is already ${currentStatus}` };
      }
      if (currentStatus === "paused" || currentStatus === "stopped") {
        // "stopped" kept here only to gracefully handle a transient read from a CLI
        // that hasn't switched to "paused" yet; the schema/UI no longer emit it.
        console.log(
          `[WorktreeLifecycle] Provision routing to resume for worktree ${worktreeId}: currently ${currentStatus}`
        );
        effectiveAction = "resume";
      }
      // otherwise (not configured / error / unknown / undefined) fall through to provision.
    }

    if (action === "status") {
      if (!resourceConfig.status) {
        this.ctx.sendEvent({
          type: "resource-action-result",
          requestId,
          success: false,
          error: "No status command configured",
        });
        return { success: false, error: "No status command configured" };
      }

      const statusCmd = sub(resourceConfig.status);

      monitor.setLifecycleStatus({
        phase: "resource-status",
        state: "running",
        commandIndex: 0,
        totalCommands: 1,
        currentCommand: statusCmd,
        startedAt: Date.now(),
      });
      this.ctx.emitUpdate(monitor);

      const statusTimeoutSec = resourceConfig.timeouts?.status;
      const statusTimeoutMs = statusTimeoutSec != null ? statusTimeoutSec * 1000 : 120_000;
      const result = await this.ctx.lifecycleService.runCommands([statusCmd], {
        cwd: monitor.path,
        env,
        timeoutMs: statusTimeoutMs,
        signal,
        onProgress: () => {},
      });

      if (result.aborted) {
        this.ctx.sendEvent({
          type: "resource-action-result",
          requestId,
          success: false,
          error: "Aborted",
        });
        return { success: false, error: "Aborted" };
      }

      // Re-read monitor after await — it may have been removed during the command
      const statusMonitor = this.ctx.getMonitor(worktreeId);
      if (!statusMonitor) return { success: false, error: "Worktree removed" };

      try {
        const parsed = JSON.parse(result.output);
        statusMonitor.setResourceStatus({
          lastStatus: parsed.status ?? "unhealthy",
          lastOutput: result.output,
          lastCheckedAt: Date.now(),
          endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
          meta: parsed.meta != null && typeof parsed.meta === "object" ? parsed.meta : undefined,
        });
      } catch {
        // Non-JSON output: if command succeeded (exit 0), treat as "unknown" (neutral) rather
        // than "unhealthy" — the script may not emit JSON but still indicates a live resource.
        // Only mark "unhealthy" when the command itself failed (non-zero exit).
        statusMonitor.setResourceStatus({
          lastStatus: result.success ? "unknown" : "unhealthy",
          lastOutput: result.output,
          lastCheckedAt: Date.now(),
        });
      }

      // Re-substitute connect command with endpoint from status
      const statusEndpoint = statusMonitor.resourceStatus?.endpoint;
      if (statusEndpoint && resourceConfig.connect) {
        const varsWithEndpoint = this.ctx.lifecycleService.buildVariables(
          statusMonitor.path,
          projectRootPath,
          statusMonitor.name,
          statusMonitor.branch,
          statusEndpoint
        );
        statusMonitor.setResourceConnectCommand(
          this.ctx.lifecycleService.substituteVariables(resourceConfig.connect, varsWithEndpoint)
        );
      }

      if (statusEndpoint && statusMonitor.resourceStatus?.lastStatus === "ready") {
        const resolvedConnect = statusMonitor.resourceConnectCommand;
        if (resolvedConnect) {
          await generateRemoteWrapper(statusMonitor.path, resolvedConnect, statusEndpoint);
        }
      }

      statusMonitor.setLifecycleStatus({
        phase: "resource-status",
        state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
        totalCommands: 1,
        output: result.output,
        error: result.error,
        startedAt: statusMonitor.lifecycleStatus?.startedAt ?? Date.now(),
        completedAt: Date.now(),
      });
      this.ctx.emitUpdate(statusMonitor);

      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: result.success,
        output: result.output,
        error: result.error,
      });
      return { success: result.success, output: result.output, error: result.error };
    }

    const commands = (
      resourceConfig[effectiveAction as "provision" | "teardown" | "resume" | "pause"] as
        | string[]
        | undefined
    )?.map(sub);
    if (!commands?.length) {
      this.ctx.sendEvent({
        type: "resource-action-result",
        requestId,
        success: false,
        error: `No ${effectiveAction} commands configured`,
      });
      return { success: false, error: `No ${effectiveAction} commands configured` };
    }

    const phase = `resource-${effectiveAction}` as const;
    const DEFAULT_TIMEOUT: Record<string, number> = {
      provision: 300_000,
      teardown: 300_000,
      resume: 120_000,
      pause: 120_000,
      status: 120_000,
    };
    const configTimeoutSec =
      resourceConfig.timeouts?.[effectiveAction as keyof typeof resourceConfig.timeouts];
    const timeoutMs =
      configTimeoutSec != null
        ? configTimeoutSec * 1000
        : (DEFAULT_TIMEOUT[effectiveAction] ?? 120_000);

    monitor.setLifecycleStatus({
      phase,
      state: "running",
      commandIndex: 0,
      totalCommands: commands.length,
      currentCommand: commands[0],
      startedAt: Date.now(),
    });
    this.ctx.emitUpdate(monitor);

    const startedAt = monitor.lifecycleStatus?.startedAt ?? Date.now();

    const result = await this.ctx.lifecycleService.runCommands(commands, {
      cwd: monitor.path,
      env,
      timeoutMs,
      signal,
      onProgress: (commandIndex, totalCommands, command) => {
        const m = this.ctx.getMonitor(worktreeId);
        if (m) {
          m.setLifecycleStatus({
            phase,
            state: "running",
            commandIndex,
            totalCommands,
            currentCommand: command,
            startedAt: m.lifecycleStatus?.startedAt ?? startedAt,
          });
          this.ctx.emitUpdate(m);
        }
      },
    });

    if (result.aborted) return { success: false, error: "Aborted" };

    const finalMonitor = this.ctx.getMonitor(worktreeId);
    if (finalMonitor) {
      finalMonitor.setLifecycleStatus({
        phase,
        state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
        totalCommands: commands.length,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: Date.now(),
      });

      if (result.success && (effectiveAction === "resume" || effectiveAction === "pause")) {
        const prevStatus = finalMonitor.resourceStatus;
        const timestampUpdate: Partial<WorktreeResourceStatus> =
          effectiveAction === "resume" ? { resumedAt: Date.now() } : { pausedAt: Date.now() };
        finalMonitor.setResourceStatus({
          ...prevStatus,
          ...timestampUpdate,
        });
      }

      this.ctx.emitUpdate(finalMonitor);
    }

    if (!result.success) {
      console.warn(
        `[WorktreeLifecycle] Resource ${action} failed for worktree ${worktreeId}:`,
        result.error
      );
    }

    this.ctx.sendEvent({
      type: "resource-action-result",
      requestId,
      success: result.success,
      output: result.output,
      error: result.error,
    });
    return { success: result.success, output: result.output, error: result.error };
  }
}

/**
 * Drop a `daintree-remote` shell wrapper into the worktree's `.daintree/`
 * directory. The wrapper forwards arguments to the resolved connect command,
 * giving agents a stable invocation path that survives endpoint changes.
 */
async function generateRemoteWrapper(
  worktreePath: string,
  connectCommand: string,
  endpoint: string
): Promise<void> {
  try {
    const wrapperPath = pathJoin(worktreePath, ".daintree", "daintree-remote");
    await mkdir(pathJoin(worktreePath, ".daintree"), { recursive: true });

    const scriptContent = `#!/usr/bin/env bash
# Auto-generated by Daintree - wraps remote compute access
# Endpoint: ${endpoint}
set -euo pipefail
if [ $# -eq 0 ]; then
  echo "Usage: daintree-remote <command>" >&2
  exit 1
fi
${connectCommand} "$@"
`;

    await writeFile(wrapperPath, scriptContent, { mode: 0o755 });
  } catch (error) {
    const msg = formatErrorMessage(error, "Failed to generate daintree-remote wrapper");
    console.warn("[WorkspaceService] Failed to generate daintree-remote wrapper:", msg);
  }
}
