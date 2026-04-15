import { spawn, spawnSync, type ChildProcess } from "child_process";
import { readFile, access, cp } from "fs/promises";
import { join as pathJoin, basename, dirname } from "path";
import os from "os";
import { z } from "zod/v4";

const OUTPUT_TAIL_BYTES = 8192;
const DEFAULT_TIMEOUT_MS = 120_000;

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

const CanopyLifecycleConfigSchema = z.object({
  setup: z.array(z.string()).optional(),
  teardown: z.array(z.string()).optional(),
  resource: ResourceConfigSchema.optional(),
  resources: ResourcesConfigSchema.optional(),
});

export type CanopyLifecycleConfig = z.infer<typeof CanopyLifecycleConfigSchema>;

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

export interface RunCommandsOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  onProgress: (commandIndex: number, totalCommands: number, command: string) => void;
}

export interface RunCommandsResult {
  success: boolean;
  output: string;
  error?: string;
  timedOut?: boolean;
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
   * 1. User-level: ~/.canopy/projects/<sanitized-rootPath>/config.json
   * 2. Worktree-level: <worktreePath>/.canopy/config.json
   * 3. Main repo level: <projectRootPath>/.canopy/config.json
   *
   * The first existing, valid config file found (highest priority first) wins completely.
   */
  async loadConfig(
    worktreePath: string,
    projectRootPath: string
  ): Promise<CanopyLifecycleConfig | null> {
    const sanitizedRoot = projectRootPath.replace(/[/\\:*?"<>|]/g, "_");
    const candidates = [
      pathJoin(this.homeDir, ".canopy", "projects", sanitizedRoot, "config.json"),
      pathJoin(worktreePath, ".canopy", "config.json"),
      pathJoin(projectRootPath, ".canopy", "config.json"),
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

      const result = CanopyLifecycleConfigSchema.safeParse(raw);
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
   * Copy .canopy/ from the main repo to the new worktree.
   * Skips if source does not exist. Existing files in dest are never overwritten
   * so worktree-level overrides are preserved.
   */
  async copyCanopyDir(srcPath: string, destPath: string): Promise<void> {
    const src = pathJoin(srcPath, ".canopy");
    const dest = pathJoin(destPath, ".canopy");

    if (!(await fileExists(src))) {
      return;
    }

    try {
      // force:false preserves any files already present in dest (e.g. worktree-level overrides)
      await cp(src, dest, { recursive: true, force: false, errorOnExist: false });
    } catch (err) {
      console.warn("[WorktreeLifecycle] Failed to copy .canopy dir:", err);
    }
  }

  /**
   * Run an array of shell commands sequentially in a given directory.
   * Each command is spawned with a minimal env + CANOPY_* vars.
   * A shared timeout covers the entire set of commands.
   * On Unix, process group kill terminates the whole tree; on Windows, taskkill /T is used.
   */
  async runCommands(commands: string[], options: RunCommandsOptions): Promise<RunCommandsResult> {
    const { cwd, env, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

    if (!commands.length) {
      return { success: true, output: "" };
    }

    const outputChunks: string[] = [];
    const deadline = Date.now() + timeoutMs;

    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        return {
          success: false,
          output: tailOutput(outputChunks),
          timedOut: true,
          error: `Timed out before running command ${i + 1}: ${command}`,
        };
      }

      onProgress(i, commands.length, command);

      const result = await this.runSingleCommand(command, cwd, env, remainingMs, outputChunks);

      if (!result.success) {
        return {
          success: false,
          output: tailOutput(outputChunks),
          timedOut: result.timedOut,
          error: result.error,
        };
      }
    }

    return { success: true, output: tailOutput(outputChunks) };
  }

  private runSingleCommand(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    outputChunks: string[]
  ): Promise<{ success: boolean; timedOut?: boolean; error?: string }> {
    const isWin = process.platform === "win32";

    return new Promise((resolve) => {
      const child: ChildProcess = spawn(command, {
        cwd,
        shell: true,
        detached: !isWin,
        env: buildSpawnEnv(env),
      });

      let timedOut = false;

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

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
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
        resolve({ success: false, error: err.message });
      });

      child.on("close", (code) => {
        clearTimeout(timeoutHandle);

        if (timedOut) {
          resolve({
            success: false,
            timedOut: true,
            error: `Command timed out: ${command}`,
          });
          return;
        }

        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({
            success: false,
            error: `Command exited with code ${code}: ${command}`,
          });
        }
      });
    });
  }

  async loadProjectResourceEnvironments(
    projectRootPath: string
  ): Promise<Record<string, ResourceConfig> | null> {
    const sanitizedRoot = projectRootPath.replace(/[/\\:*?"<>|]/g, "_");
    const candidates = [
      pathJoin(this.homeDir, ".canopy", "projects", sanitizedRoot, "settings.json"),
      pathJoin(projectRootPath, ".canopy", "settings.json"),
    ];
    for (const settingsPath of candidates) {
      if (!(await fileExists(settingsPath))) continue;
      const raw = await readJsonFile(settingsPath);
      if (!raw || typeof raw !== "object") continue;
      const settings = raw as Record<string, unknown>;
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
      // Migration: check old singular resourceEnvironment
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
      ...(extraEnv ?? {}), // project vars first — CANOPY_* below will override
      CI: "true",
      NONINTERACTIVE: "1",
      GIT_TERMINAL_PROMPT: "0",
      DEBIAN_FRONTEND: "noninteractive",
      CANOPY_WORKTREE_PATH: worktreePath,
      CANOPY_PROJECT_ROOT: projectRootPath,
      CANOPY_WORKTREE_NAME: worktreeName,
    };
    if (branch) {
      env.CANOPY_BRANCH = branch;
    }
    if (resource?.provider) {
      env.CANOPY_RESOURCE_PROVIDER = resource.provider;
    }
    if (resource?.endpoint) {
      env.CANOPY_RESOURCE_ENDPOINT = resource.endpoint;
    }
    if (resource?.lastOutput) {
      env.CANOPY_RESOURCE_STATUS = resource.lastOutput;
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
  if (process.platform === "win32") {
    const sysRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    return {
      PATH: process.env.PATH ?? `${sysRoot}\\System32;${sysRoot};${sysRoot}\\System32\\Wbem`,
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      SystemRoot: sysRoot,
      USERPROFILE: process.env.USERPROFILE ?? os.homedir(),
      TEMP: process.env.TEMP ?? os.tmpdir(),
      TMP: process.env.TMP ?? os.tmpdir(),
      TERM: "dumb",
      ...customEnv,
    };
  }
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    TERM: "dumb",
    ...customEnv,
  };
}

function tailOutput(chunks: string[]): string {
  const full = chunks.join("");
  if (full.length <= OUTPUT_TAIL_BYTES) {
    return full;
  }
  return "...(truncated)\n" + full.slice(full.length - OUTPUT_TAIL_BYTES);
}
