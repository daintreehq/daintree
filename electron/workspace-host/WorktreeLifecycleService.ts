import { spawn, spawnSync, type ChildProcess } from "child_process";
import { readFile, access, cp, mkdir, readdir, unlink } from "fs/promises";
import { join as pathJoin, basename, dirname } from "path";
import os from "os";
import { z } from "zod/v4";
import { scrubSecrets } from "../utils/secretScrubber.js";
import { buildProbeEnv } from "../utils/spawnEnv.js";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import type { WorktreeMonitor } from "./WorktreeMonitor.js";
import type {
  WorktreeLifecyclePhase,
  WorktreeLifecyclePhaseCategory,
  WorktreeLifecycleState,
} from "../../shared/types/worktree.js";
import { applyResourceConfigToMonitor } from "./resourceConfigHelpers.js";

const OUTPUT_TAIL_BYTES = 8192;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TEARDOWN_LOGS_PER_WORKTREE = 10;

const ResourceTimeoutsSchema = z.object({
  provision: z.number().positive().optional(),
  teardown: z.number().positive().optional(),
  resume: z.number().positive().optional(),
  pause: z.number().positive().optional(),
  status: z.number().positive().optional(),
});

const ResourceConfigSchema = z.object({
  provision: z.array(z.string()).optional(),
  teardown: z.array(z.string()).optional(),
  resume: z.array(z.string()).optional(),
  pause: z.array(z.string()).optional(),
  status: z.string().optional(),
  connect: z.string().optional(),
  timeouts: ResourceTimeoutsSchema.optional(),
  statusInterval: z.number().positive().optional(),
  provider: z.string().optional(),
});

export type ResourceConfig = z.infer<typeof ResourceConfigSchema>;

const ResourcesConfigSchema = z.record(z.string(), ResourceConfigSchema);

const DaintreeLifecycleConfigSchema = z.object({
  setup: z.array(z.string()).optional(),
  teardown: z.array(z.string()).optional(),
  resource: ResourceConfigSchema.optional(),
  resources: ResourcesConfigSchema.optional(),
});

export type DaintreeLifecycleConfig = z.infer<typeof DaintreeLifecycleConfigSchema>;

/** Variables available for {{variable}} substitution in lifecycle commands. */
export interface LifecycleVariables {
  branch?: string;
  worktree_path: string;
  worktree_name: string;
  project_root: string;
  endpoint?: string;
  // Single-brace variables
  "parent-dir"?: string;
  "base-folder"?: string;
  "branch-slug"?: string;
  "repo-name"?: string;
}

/**
 * Per-call context the host (WorkspaceService) provides so lifecycle methods
 * can read project-level state and interact with the live monitor registry
 * without holding a back-reference to WorkspaceService. Keeps this service
 * stateless and per-project — see lessons #3323 and #4647.
 */
export interface WorkspaceHostContext {
  readonly projectRootPath: string;
  readonly projectEnvVars: Readonly<Record<string, string>>;
  getMonitor(id: string): WorktreeMonitor | undefined;
  emitUpdate(monitor: WorktreeMonitor): void;
}

export interface RunCommandsOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress: (commandIndex: number, totalCommands: number, command: string) => void;
  /**
   * When set, the full scrubbed output for this run is persisted to a new file
   * inside this directory. The returned `RunCommandsResult.logPath` is the
   * absolute path on success, or undefined if the write or directory creation
   * failed (failures never abort the run — log persistence is best-effort).
   * Callers that don't want persistence (resource status polls, setup) omit it.
   */
  logDir?: string;
}

export interface RunCommandsResult {
  success: boolean;
  output: string;
  error?: string;
  timedOut?: boolean;
  aborted?: boolean;
  /** Absolute path to the persisted full-output log file, when one was written. */
  logPath?: string;
  /**
   * Exit code of the first failing command (or 0 on success), captured
   * structurally from the child-process `close` event. `null` when the
   * process was killed by a signal or never produced an exit code.
   */
  exitCode?: number | null;
  /**
   * Signal name that terminated the first failing command (e.g. "SIGKILL"
   * after timeout escalation). `null` for a normal exit. Kept separate from
   * `exitCode` so an aborted/killed run is distinguishable from a self-
   * inflicted non-zero exit (lesson #4054).
   */
  signalName?: string | null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(p: string): Promise<unknown | null> {
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class WorktreeLifecycleService {
  constructor(private readonly homeDir: string = os.homedir()) {}

  /**
   * Load the merged lifecycle config for a worktree, using the priority chain:
   * 1. User-level: ~/.daintree/projects/<sanitized-rootPath>/config.json
   * 2. Worktree-level: <worktreePath>/.daintree/config.json
   * 3. Main repo level: <projectRootPath>/.daintree/config.json
   *
   * The first existing, valid config file found (highest priority first) wins completely.
   */
  async loadConfig(
    worktreePath: string,
    projectRootPath: string
  ): Promise<DaintreeLifecycleConfig | null> {
    const sanitizedRoot = sanitizePathSegment(projectRootPath);
    const candidates = [
      pathJoin(this.homeDir, ".daintree", "projects", sanitizedRoot, "config.json"),
      pathJoin(worktreePath, ".daintree", "config.json"),
      pathJoin(projectRootPath, ".daintree", "config.json"),
    ];

    for (const configPath of candidates) {
      if (!(await fileExists(configPath))) {
        continue;
      }

      const raw = await readJsonFile(configPath);
      if (raw === null) {
        console.warn("[WorktreeLifecycle] Failed to parse config at:", configPath);
        continue;
      }

      const result = DaintreeLifecycleConfigSchema.safeParse(raw);
      if (!result.success) {
        console.warn("[WorktreeLifecycle] Invalid config at:", configPath, result.error.message);
        continue;
      }

      return result.data;
    }

    return null;
  }

  /**
   * Load the resolved resource config for a specific environment.
   * Resolution chain: resources[environmentId] > resources["default"] > resources[first] > resource (singular)
   */
  async loadResourceConfig(
    worktreePath: string,
    projectRootPath: string,
    environmentId?: string
  ): Promise<ResourceConfig | null> {
    const config = await this.loadConfig(worktreePath, projectRootPath);
    if (!config) return null;

    if (config.resources) {
      if (environmentId && config.resources[environmentId]) {
        return config.resources[environmentId];
      }
      if (config.resources["default"]) {
        return config.resources["default"];
      }
      const keys = Object.keys(config.resources);
      if (keys.length > 0) {
        return config.resources[keys[0]];
      }
    }

    return config.resource ?? null;
  }

  /**
   * Copy .daintree/ from the main repo to the new worktree.
   * Skips if source does not exist. Existing files in dest are never overwritten
   * so worktree-level overrides are preserved.
   */
  async copyDaintreeDir(srcPath: string, destPath: string): Promise<void> {
    const src = pathJoin(srcPath, ".daintree");
    const dest = pathJoin(destPath, ".daintree");

    if (!(await fileExists(src))) {
      return;
    }

    // force:false preserves any files already present in dest (e.g. worktree-level overrides).
    // Caller is expected to catch — they hold the `worktreeId` needed to surface the error.
    await cp(src, dest, { recursive: true, force: false, errorOnExist: false });
  }

  /**
   * Run an array of shell commands sequentially in a given directory.
   * Each command is spawned with a minimal env + DAINTREE_* vars.
   * A shared timeout covers the entire set of commands.
   * On Unix, process group kill terminates the whole tree; on Windows, taskkill /T is used.
   *
   * When `options.logDir` is set, a per-run scrubbed log is persisted there
   * after the run completes. Empty command arrays short-circuit with no log
   * write (callers in `runLifecycleTeardown` already guard against this, so
   * the early-return has no impact on the teardown log story).
   */
  async runCommands(commands: string[], options: RunCommandsOptions): Promise<RunCommandsResult> {
    const { cwd, env, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS, signal, logDir } = options;

    if (!commands.length) {
      return { success: true, output: "" };
    }

    const outputChunks: string[] = [];
    const deadline = Date.now() + timeoutMs;

    for (let i = 0; i < commands.length; i++) {
      if (signal?.aborted) {
        const logPath = await this.persistRunLog(outputChunks, logDir);
        return {
          success: false,
          output: tailOutput(outputChunks, logPath),
          aborted: true,
          error: "Aborted",
          logPath,
          exitCode: null,
          signalName: null,
        };
      }

      const command = commands[i];
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        const logPath = await this.persistRunLog(outputChunks, logDir);
        return {
          success: false,
          output: tailOutput(outputChunks, logPath),
          timedOut: true,
          error: `Timed out before running command ${i + 1}: ${command}`,
          logPath,
          exitCode: null,
          signalName: null,
        };
      }

      onProgress(i, commands.length, command);

      const result = await this.runSingleCommand(
        command,
        cwd,
        env,
        remainingMs,
        outputChunks,
        signal
      );

      if (result.aborted) {
        const logPath = await this.persistRunLog(outputChunks, logDir);
        return {
          success: false,
          output: tailOutput(outputChunks, logPath),
          aborted: true,
          error: "Aborted",
          logPath,
          exitCode: result.exitCode ?? null,
          signalName: result.signalName ?? null,
        };
      }

      if (!result.success) {
        const logPath = await this.persistRunLog(outputChunks, logDir);
        return {
          success: false,
          output: tailOutput(outputChunks, logPath),
          timedOut: result.timedOut,
          error: result.error,
          logPath,
          exitCode: result.exitCode ?? null,
          signalName: result.signalName ?? null,
        };
      }
    }

    const logPath = await this.persistRunLog(outputChunks, logDir);
    return {
      success: true,
      output: tailOutput(outputChunks, logPath),
      logPath,
      exitCode: 0,
      signalName: null,
    };
  }

  private runSingleCommand(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    outputChunks: string[],
    signal?: AbortSignal
  ): Promise<{
    success: boolean;
    timedOut?: boolean;
    aborted?: boolean;
    error?: string;
    exitCode?: number | null;
    signalName?: string | null;
  }> {
    if (signal?.aborted) {
      return Promise.resolve({
        success: false,
        aborted: true,
        error: "Aborted",
        exitCode: null,
        signalName: null,
      });
    }

    const isWin = process.platform === "win32";

    return new Promise((resolve) => {
      const child: ChildProcess = spawn(command, {
        cwd,
        shell: true,
        detached: !isWin,
        env: buildSpawnEnv(env),
      });

      let timedOut = false;
      let aborted = false;

      const killProcess = () => {
        if (isWin) {
          if (child.pid !== undefined) {
            spawnSync("taskkill", ["/F", "/T", "/PID", child.pid.toString()], {
              windowsHide: true,
            });
          } else {
            child.kill();
          }
          return;
        }

        // Unix: SIGTERM the process group, escalate to SIGKILL after 5s
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          // Process may have already exited
        }
        setTimeout(() => {
          try {
            if (child.pid !== undefined) {
              process.kill(-child.pid, "SIGKILL");
            } else {
              child.kill("SIGKILL");
            }
          } catch {
            // Already gone
          }
        }, 5_000);
      };

      const onAbort = () => {
        aborted = true;
        // Append the marker before killing so it lands in the captured tail
        // even if no further output arrives after the kill.
        outputChunks.push(`\n[Process aborted: ${command}]\n`);
        killProcess();
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        outputChunks.push(`\n[Process timed out after ${timeoutMs}ms: ${command}]\n`);
        killProcess();
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        outputChunks.push(chunk.toString());
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        outputChunks.push(chunk.toString());
      });

      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
        resolve({ success: false, error: err.message, exitCode: null, signalName: null });
      });

      // `closeSignal` is the OS signal name (e.g. "SIGKILL") on Unix when the
      // process was killed; `null` on a normal exit. Named distinctly from the
      // `signal` AbortSignal param to avoid shadowing.
      child.on("close", (code, closeSignal) => {
        clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);

        const exitCode = code ?? null;
        const signalName = closeSignal ?? null;

        if (aborted) {
          resolve({ success: false, aborted: true, error: "Aborted", exitCode, signalName });
          return;
        }

        if (timedOut) {
          resolve({
            success: false,
            timedOut: true,
            error: `Command timed out: ${command}`,
            exitCode,
            signalName,
          });
          return;
        }

        if (code === 0) {
          resolve({ success: true, exitCode, signalName });
        } else {
          const signalSuffix = signalName ? ` (killed by ${signalName})` : "";
          resolve({
            success: false,
            error: `Command exited with code ${code}${signalSuffix}: ${command}`,
            exitCode,
            signalName,
          });
        }
      });
    });
  }

  /**
   * Persist the full scrubbed output of a command run to a new log file inside
   * `logDir` and prune the directory to `MAX_TEARDOWN_LOGS_PER_WORKTREE`
   * entries. Best-effort — any failure resolves to `undefined` so the caller
   * (teardown) can continue. Returns the absolute log path on success.
   *
   * Filename uses `Date.now()` so files sort lexicographically by write order,
   * which keeps the prune step a simple sorted-by-name slice (no per-file
   * `stat` round-trip). A collision is harmless: an atomic rename overwrite
   * keeps the newer content.
   */
  private async persistRunLog(
    chunks: string[],
    logDir: string | undefined
  ): Promise<string | undefined> {
    if (!logDir) return undefined;
    try {
      const scrubbed = scrubSecrets(chunks.join(""));
      await mkdir(logDir, { recursive: true });
      const logPath = pathJoin(logDir, `${Date.now()}.log`);
      await resilientAtomicWriteFile(logPath, scrubbed, "utf-8");
      await this.pruneOldLogs(logDir);
      return logPath;
    } catch (err) {
      console.warn("[WorktreeLifecycle] Failed to persist teardown log:", err);
      return undefined;
    }
  }

  /**
   * Delete the oldest `.log` files beyond `MAX_TEARDOWN_LOGS_PER_WORKTREE`.
   * Best-effort — every individual unlink is swallowed so one stuck file
   * doesn't block pruning the rest, and a failed prune never aborts the run.
   */
  private async pruneOldLogs(logDir: string): Promise<void> {
    try {
      const entries = await readdir(logDir);
      const logs = entries.filter((name) => name.endsWith(".log")).sort();
      const excess = logs.length - MAX_TEARDOWN_LOGS_PER_WORKTREE;
      if (excess <= 0) return;
      const toDelete = logs.slice(0, excess);
      for (const name of toDelete) {
        try {
          await unlink(pathJoin(logDir, name));
        } catch {
          // best-effort; permission errors or already-gone files are non-fatal
        }
      }
    } catch (err) {
      console.warn("[WorktreeLifecycle] Failed to prune teardown logs:", err);
    }
  }

  /**
   * Compute the per-worktree teardown-log directory under the user-level
   * project config root. Returns an absolute path; callers don't need to
   * create the directory — `persistRunLog` does that on demand.
   */
  private teardownLogDir(projectRootPath: string, worktreeName: string): string {
    return pathJoin(
      this.homeDir,
      ".daintree",
      "projects",
      sanitizePathSegment(projectRootPath),
      "teardown-logs",
      sanitizePathSegment(worktreeName)
    );
  }

  /**
   * Classify a phase's failure severity. Resource teardown can leave cloud
   * resources running and billing, so its failures are billing-critical;
   * everything else is local cleanup whose directory is about to be deleted.
   */
  private phaseCategory(phase: WorktreeLifecyclePhase): WorktreeLifecyclePhaseCategory {
    return phase === "resource-teardown" ? "billing-critical" : "cosmetic";
  }

  /** Map a RunCommandsResult onto a WorktreeLifecycleState. */
  private resultState(result: { success: boolean; timedOut?: boolean }): WorktreeLifecycleState {
    return result.timedOut ? "timed-out" : result.success ? "success" : "failed";
  }

  async loadProjectResourceEnvironments(
    projectRootPath: string
  ): Promise<Record<string, ResourceConfig> | null> {
    const sanitizedRoot = sanitizePathSegment(projectRootPath);
    const candidates = [
      pathJoin(this.homeDir, ".daintree", "projects", sanitizedRoot, "settings.json"),
      pathJoin(projectRootPath, ".daintree", "settings.json"),
    ];
    for (const settingsPath of candidates) {
      if (!(await fileExists(settingsPath))) continue;
      const raw = await readJsonFile(settingsPath);
      if (!raw || typeof raw !== "object") continue;
      const settings = raw as Record<string, unknown>;
      // resourceEnvironment (singular) → resourceEnvironments (plural) is
      // canonicalised by projectSettingsCodec on the main-process read path,
      // but the workspace-host reads the raw settings.json file directly
      // (not through the codec) so the fallback stays here for the window
      // between an upgrade and the user's first settings interaction.
      if (settings.resourceEnvironments && typeof settings.resourceEnvironments === "object") {
        const result: Record<string, ResourceConfig> = {};
        for (const [key, value] of Object.entries(
          settings.resourceEnvironments as Record<string, unknown>
        )) {
          const parsed = ResourceConfigSchema.safeParse(value);
          if (parsed.success) result[key] = parsed.data;
        }
        if (Object.keys(result).length > 0) return result;
      }
      if (settings.resourceEnvironment && typeof settings.resourceEnvironment === "object") {
        const parsed = ResourceConfigSchema.safeParse(settings.resourceEnvironment);
        if (parsed.success) {
          return { default: parsed.data };
        }
      }
    }
    return null;
  }

  buildEnv(
    worktreePath: string,
    projectRootPath: string,
    worktreeName: string,
    branch?: string,
    resource?: { provider?: string; endpoint?: string; lastOutput?: string },
    extraEnv?: Record<string, string>
  ): Record<string, string> {
    const env: Record<string, string> = {
      ...(extraEnv ?? {}), // project vars first — DAINTREE_* below will override
      CI: "true",
      NONINTERACTIVE: "1",
      GIT_TERMINAL_PROMPT: "0",
      DEBIAN_FRONTEND: "noninteractive",
      DAINTREE_WORKTREE_PATH: worktreePath,
      DAINTREE_PROJECT_ROOT: projectRootPath,
      DAINTREE_WORKTREE_NAME: worktreeName,
    };
    if (branch) {
      env.DAINTREE_BRANCH = branch;
    }
    if (resource?.provider) {
      env.DAINTREE_RESOURCE_PROVIDER = resource.provider;
    }
    if (resource?.endpoint) {
      env.DAINTREE_RESOURCE_ENDPOINT = resource.endpoint;
    }
    if (resource?.lastOutput) {
      env.DAINTREE_RESOURCE_STATUS = resource.lastOutput;
    }
    return env;
  }

  buildVariables(
    worktreePath: string,
    projectRootPath: string,
    worktreeName: string,
    branch?: string,
    endpoint?: string
  ): LifecycleVariables {
    const baseFolder = basename(projectRootPath);
    const branchSlug = branch
      ? branch
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
      : undefined;
    return {
      branch,
      worktree_path: worktreePath,
      worktree_name: worktreeName,
      project_root: projectRootPath,
      endpoint,
      "parent-dir": dirname(projectRootPath),
      "base-folder": baseFolder,
      "branch-slug": branchSlug,
      "repo-name": baseFolder,
    };
  }

  /**
   * Orchestrate the setup phase for a worktree: load+resolve config, cache
   * resource metadata on the monitor, run any setup commands, and report
   * progress via the monitor's lifecycle status.
   *
   * Returns `{ shouldProvision }` so the host can decide whether to kick off
   * an auto-provision run — keeping that orchestration in WorkspaceService
   * avoids a circular call back into the host.
   *
   * Re-fetches the monitor via `ctx.getMonitor` after every `await` because the
   * worktree may have been deleted mid-run.
   */
  async runLifecycleSetup(
    worktreeId: string,
    worktreePath: string,
    ctx: WorkspaceHostContext,
    provisionResource?: boolean,
    environmentId?: string
  ): Promise<{ shouldProvision: boolean }> {
    const projectRootPath = ctx.projectRootPath;
    const config = await this.loadConfig(worktreePath, projectRootPath);

    // Resolve resource config: prefer resources (plural) over resource (singular)
    let resolvedResource = config?.resource;
    if (config?.resources) {
      if (environmentId && config.resources[environmentId]) {
        resolvedResource = config.resources[environmentId];
      } else if (config.resources["default"]) {
        resolvedResource = config.resources["default"];
      } else {
        const keys = Object.keys(config.resources);
        if (keys.length > 0) {
          resolvedResource = config.resources[keys[0]];
        }
      }
    }

    // Fallback: resolve from project settings resourceEnvironments
    if (!resolvedResource) {
      const monitor = ctx.getMonitor(worktreeId);
      const envKey = monitor?.worktreeMode;
      if (envKey && envKey !== "local") {
        const envs = await this.loadProjectResourceEnvironments(projectRootPath);
        resolvedResource = envs?.[envKey] ?? undefined;
      }
    }

    if (!config?.setup?.length && !(provisionResource && resolvedResource?.provision?.length)) {
      // Cache resource config even if no setup commands
      if (resolvedResource) {
        const m = ctx.getMonitor(worktreeId);
        if (m) {
          const v = this.buildVariables(worktreePath, projectRootPath, m.name, m.branch);
          const subCache = (cmd: string) => this.substituteVariables(cmd, v);
          applyResourceConfigToMonitor(m, resolvedResource, subCache);
          ctx.emitUpdate(m);
        }
      }
      return { shouldProvision: false };
    }

    if (!config) return { shouldProvision: false };

    const monitor = ctx.getMonitor(worktreeId);
    if (!monitor) {
      return { shouldProvision: false };
    }

    const worktreeName = monitor.name;
    const vars = this.buildVariables(worktreePath, projectRootPath, worktreeName, monitor.branch);
    const sub = (cmd: string) => this.substituteVariables(cmd, vars);
    const commands = (config.setup ?? []).map(sub);
    const env = this.buildEnv(
      worktreePath,
      projectRootPath,
      worktreeName,
      monitor.branch,
      {
        provider: resolvedResource?.provider,
        endpoint: monitor.resourceStatus?.endpoint,
        lastOutput: monitor.resourceStatus?.lastOutput,
      },
      ctx.projectEnvVars
    );

    monitor.setLifecycleStatus({
      phase: "setup",
      state: "running",
      commandIndex: 0,
      totalCommands: commands.length,
      currentCommand: commands[0],
      startedAt: Date.now(),
    });
    ctx.emitUpdate(monitor);

    const result = await this.runCommands(commands, {
      cwd: worktreePath,
      env,
      onProgress: (commandIndex, totalCommands, command) => {
        const m = ctx.getMonitor(worktreeId);
        if (m) {
          m.setLifecycleStatus({
            phase: "setup",
            state: "running",
            commandIndex,
            totalCommands,
            currentCommand: command,
            startedAt: m.lifecycleStatus?.startedAt ?? Date.now(),
          });
          ctx.emitUpdate(m);
        }
      },
    });

    const finalMonitor = ctx.getMonitor(worktreeId);
    if (finalMonitor) {
      finalMonitor.setLifecycleStatus({
        phase: "setup",
        state: result.timedOut ? "timed-out" : result.success ? "success" : "failed",
        totalCommands: commands.length,
        output: result.output,
        error: result.error,
        startedAt: finalMonitor.lifecycleStatus?.startedAt ?? Date.now(),
        completedAt: Date.now(),
      });
      ctx.emitUpdate(finalMonitor);
    }

    if (!result.success) {
      console.warn(`[WorktreeLifecycle] Setup failed for worktree ${worktreeId}:`, result.error);
    }

    if (resolvedResource) {
      const m = ctx.getMonitor(worktreeId);
      if (m) {
        applyResourceConfigToMonitor(m, resolvedResource, sub);
        ctx.emitUpdate(m);
      }
    }

    const shouldProvision = !!(
      result.success &&
      provisionResource &&
      resolvedResource?.provision?.length
    );
    return { shouldProvision };
  }

  /**
   * Orchestrate the teardown phase for a worktree: resource teardown first
   * (when configured), then regular teardown, reporting progress through the
   * monitor's lifecycle status. Teardown failures are logged but never thrown
   * — deletion must proceed regardless.
   */
  async runLifecycleTeardown(
    worktreeId: string,
    monitor: WorktreeMonitor,
    force: boolean,
    ctx: WorkspaceHostContext
  ): Promise<void> {
    const projectRootPath = ctx.projectRootPath;
    const config = await this.loadConfig(monitor.path, projectRootPath);

    // Resolve resource config for teardown
    let teardownResource = config?.resource;
    if (config?.resources) {
      if (config.resources["default"]) {
        teardownResource = config.resources["default"];
      } else {
        const keys = Object.keys(config.resources);
        if (keys.length > 0) {
          teardownResource = config.resources[keys[0]];
        }
      }
    }

    // Fallback: resolve from project settings resourceEnvironments
    if (!teardownResource) {
      const envKey = monitor.worktreeMode;
      if (envKey && envKey !== "local") {
        const envs = await this.loadProjectResourceEnvironments(projectRootPath);
        teardownResource = envs?.[envKey] ?? undefined;
      }
    }

    // Start a fresh accumulation for this teardown invocation. Owned by the
    // orchestrator (not coupled to setLifecycleStatus(undefined)) so a monitor
    // reset elsewhere can't silently drop billing-critical failure data.
    // Cleared before the early-return guard so a re-invocation whose config no
    // longer has teardown commands doesn't leave stale results in the snapshot.
    monitor.clearLifecyclePhaseResults();

    const hasResourceTeardown = teardownResource?.teardown?.length && monitor.hasResourceConfig;
    if (!config?.teardown?.length && !hasResourceTeardown) {
      return;
    }

    const vars = this.buildVariables(monitor.path, projectRootPath, monitor.name, monitor.branch);
    const sub = (cmd: string) => this.substituteVariables(cmd, vars);
    const env = this.buildEnv(
      monitor.path,
      projectRootPath,
      monitor.name,
      monitor.branch,
      {
        provider: teardownResource?.provider,
        endpoint: monitor.resourceStatus?.endpoint,
        lastOutput: monitor.resourceStatus?.lastOutput,
      },
      ctx.projectEnvVars
    );

    if (hasResourceTeardown) {
      const resourceTeardownCommands = teardownResource!.teardown!.map(sub);

      monitor.setLifecycleStatus({
        phase: "resource-teardown",
        state: "running",
        commandIndex: 0,
        totalCommands: resourceTeardownCommands.length,
        currentCommand: resourceTeardownCommands[0],
        startedAt: Date.now(),
      });
      ctx.emitUpdate(monitor);

      const resourceStartedAt = monitor.lifecycleStatus?.startedAt ?? Date.now();

      try {
        const resourceResult = await this.runCommands(resourceTeardownCommands, {
          cwd: monitor.path,
          env,
          timeoutMs: 300_000,
          logDir: this.teardownLogDir(projectRootPath, monitor.name),
          onProgress: (commandIndex, totalCommands, command) => {
            const m = ctx.getMonitor(worktreeId);
            if (m) {
              m.setLifecycleStatus({
                phase: "resource-teardown",
                state: "running",
                commandIndex,
                totalCommands,
                currentCommand: command,
                startedAt: m.lifecycleStatus?.startedAt ?? resourceStartedAt,
              });
              ctx.emitUpdate(m);
            }
          },
        });

        const m = ctx.getMonitor(worktreeId);
        if (m) {
          const state = this.resultState(resourceResult);
          const completedAt = Date.now();
          m.setLifecycleStatus({
            phase: "resource-teardown",
            state,
            totalCommands: resourceTeardownCommands.length,
            output: resourceResult.output,
            error: resourceResult.error,
            startedAt: resourceStartedAt,
            completedAt,
            logPath: resourceResult.logPath,
          });
          m.recordLifecyclePhaseResult({
            phase: "resource-teardown",
            state,
            category: this.phaseCategory("resource-teardown"),
            exitCode: resourceResult.exitCode ?? null,
            signalName: resourceResult.signalName ?? null,
            output: resourceResult.output,
            error: resourceResult.error,
            startedAt: resourceStartedAt,
            completedAt,
            timedOut: resourceResult.timedOut,
            aborted: resourceResult.aborted,
          });
          ctx.emitUpdate(m);
        }

        if (!resourceResult.success) {
          console.warn(
            `[WorktreeLifecycle] Resource teardown failed for worktree ${worktreeId} (continuing):`,
            resourceResult.error
          );
        }
      } catch (err) {
        const m = ctx.getMonitor(worktreeId);
        if (m) {
          const completedAt = Date.now();
          m.setLifecycleStatus({
            phase: "resource-teardown",
            state: "failed",
            totalCommands: resourceTeardownCommands.length,
            error: (err as Error).message,
            startedAt: resourceStartedAt,
            completedAt,
          });
          m.recordLifecyclePhaseResult({
            phase: "resource-teardown",
            state: "failed",
            category: this.phaseCategory("resource-teardown"),
            exitCode: null,
            signalName: null,
            error: (err as Error).message,
            startedAt: resourceStartedAt,
            completedAt,
          });
          ctx.emitUpdate(m);
        }
        console.warn(
          `[WorktreeLifecycle] Resource teardown threw for worktree ${worktreeId} (continuing):`,
          err
        );
      }
    }

    if (!config?.teardown?.length) {
      return;
    }

    const commands = config.teardown.map(sub);
    const timeoutMs = force ? 15_000 : 120_000;

    monitor.setLifecycleStatus({
      phase: "teardown",
      state: "running",
      commandIndex: 0,
      totalCommands: commands.length,
      currentCommand: commands[0],
      startedAt: Date.now(),
    });
    ctx.emitUpdate(monitor);

    const teardownStartedAt = monitor.lifecycleStatus?.startedAt ?? Date.now();

    try {
      const result = await this.runCommands(commands, {
        cwd: monitor.path,
        env,
        timeoutMs,
        logDir: this.teardownLogDir(projectRootPath, monitor.name),
        onProgress: (commandIndex, totalCommands, command) => {
          const m = ctx.getMonitor(worktreeId);
          if (m) {
            m.setLifecycleStatus({
              phase: "teardown",
              state: "running",
              commandIndex,
              totalCommands,
              currentCommand: command,
              startedAt: m.lifecycleStatus?.startedAt ?? teardownStartedAt,
            });
            ctx.emitUpdate(m);
          }
        },
      });

      const finalMonitor = ctx.getMonitor(worktreeId);
      if (finalMonitor) {
        const state = this.resultState(result);
        const completedAt = Date.now();
        finalMonitor.setLifecycleStatus({
          phase: "teardown",
          state,
          totalCommands: commands.length,
          output: result.output,
          error: result.error,
          startedAt: teardownStartedAt,
          completedAt,
          logPath: result.logPath,
        });
        finalMonitor.recordLifecyclePhaseResult({
          phase: "teardown",
          state,
          category: this.phaseCategory("teardown"),
          exitCode: result.exitCode ?? null,
          signalName: result.signalName ?? null,
          output: result.output,
          error: result.error,
          startedAt: teardownStartedAt,
          completedAt,
          timedOut: result.timedOut,
          aborted: result.aborted,
        });
        ctx.emitUpdate(finalMonitor);
      }

      if (!result.success) {
        console.warn(
          `[WorktreeLifecycle] Teardown failed for worktree ${worktreeId} (continuing deletion):`,
          result.error
        );
      }
    } catch (err) {
      const finalMonitor = ctx.getMonitor(worktreeId);
      if (finalMonitor) {
        const completedAt = Date.now();
        finalMonitor.setLifecycleStatus({
          phase: "teardown",
          state: "failed",
          totalCommands: commands.length,
          error: (err as Error).message,
          startedAt: teardownStartedAt,
          completedAt,
        });
        finalMonitor.recordLifecyclePhaseResult({
          phase: "teardown",
          state: "failed",
          category: this.phaseCategory("teardown"),
          exitCode: null,
          signalName: null,
          error: (err as Error).message,
          startedAt: teardownStartedAt,
          completedAt,
        });
        ctx.emitUpdate(finalMonitor);
      }
      console.warn(
        `[WorktreeLifecycle] Teardown threw for worktree ${worktreeId} (continuing deletion):`,
        err
      );
    }
  }

  /**
   * Replace {{variable}} and {variable} placeholders in a command string.
   * Unresolved variables are left as-is so the shell command fails loudly.
   * Values are shell-escaped to prevent injection via untrusted inputs
   * (e.g. branch names containing shell metacharacters).
   */
  substituteVariables(command: string, vars: LifecycleVariables): string {
    // Double-brace: {{variable}} with snake_case keys
    let result = command.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
      const key = name.toLowerCase() as keyof LifecycleVariables;
      const value = vars[key];
      return value != null ? shellEscapeValue(value) : match;
    });
    // Single-brace: {variable} with hyphenated keys — skip shell vars like ${foo}
    // {branch-slug} is safe unquoted — its charset is locked to [a-z0-9-]
    result = result.replace(/(?<!\$)\{([\w-]+)\}/g, (match, name: string) => {
      const key = name.toLowerCase() as keyof LifecycleVariables;
      const value = vars[key];
      if (value == null) return match;
      if (key === "branch-slug")
        return /^[a-z0-9-]*$/.test(value) ? value : shellEscapeValue(value);
      return shellEscapeValue(value);
    });
    return result;
  }
}

/**
 * Shell-escape a value for safe interpolation into a command string run with
 * `shell: true`. On Unix (/bin/sh), wraps in single quotes with embedded
 * single-quote escaping. On Windows (cmd.exe), wraps in double quotes with
 * percent and double-quote escaping (cmd.exe expands %VAR% inside quotes).
 */
function shellEscapeValue(value: string): string {
  if (process.platform === "win32") {
    return '"' + value.replace(/%/g, "%%").replace(/"/g, '""') + '"';
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function buildSpawnEnv(customEnv: Record<string, string>): Record<string, string> {
  return { ...buildProbeEnv(), ...customEnv };
}

function tailOutput(chunks: string[], logPath?: string): string {
  const full = chunks.join("");
  const buf = Buffer.from(full, "utf-8");
  if (buf.length <= OUTPUT_TAIL_BYTES) {
    return scrubSecrets(full);
  }
  // Byte-accurate slice: matches the named cap (`*_BYTES`) for multibyte
  // content. A cut mid-codepoint produces a leading U+FFFD in the tail snippet
  // — acceptable since the persisted log file is the authoritative artifact.
  const tail = buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString("utf-8");
  const dropped = buf.length - OUTPUT_TAIL_BYTES;
  const where = logPath ? `full log: ${logPath}` : "full log unavailable";
  const marker = `...(truncated — omitted ${dropped} bytes; ${where})\n`;
  return scrubSecrets(marker + tail);
}

/**
 * Sanitize a path segment for the user-level config root so directory names
 * remain valid on every supported OS. Mirrors the inline pattern already used
 * in `loadConfig` and `loadProjectResourceEnvironments`. Exported at module
 * scope so it can be reused by `teardownLogDir` without `this` binding.
 */
function sanitizePathSegment(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}
