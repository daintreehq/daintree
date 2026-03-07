import { spawn, type ChildProcess } from "child_process";
import { readFile, access, cp } from "fs/promises";
import { join as pathJoin } from "path";
import os from "os";
import { z } from "zod/v4";

const OUTPUT_TAIL_BYTES = 8192;
const DEFAULT_TIMEOUT_MS = 120_000;

const CanopyLifecycleConfigSchema = z.object({
  setup: z.array(z.string()).optional(),
  teardown: z.array(z.string()).optional(),
});

export type CanopyLifecycleConfig = z.infer<typeof CanopyLifecycleConfigSchema>;

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
   * Process group kill is used on timeout to terminate the whole tree.
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
    return new Promise((resolve) => {
      const child: ChildProcess = spawn(command, {
        cwd,
        shell: true,
        detached: true,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? os.homedir(),
          TERM: "dumb",
          ...env,
        },
      });

      let timedOut = false;

      const killProcess = () => {
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          // Process may have already exited
        }
        // Escalate to SIGKILL after 5s if SIGTERM was ignored
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

  buildEnv(
    worktreePath: string,
    projectRootPath: string,
    worktreeName: string
  ): Record<string, string> {
    return {
      CI: "true",
      NONINTERACTIVE: "1",
      GIT_TERMINAL_PROMPT: "0",
      DEBIAN_FRONTEND: "noninteractive",
      CANOPY_WORKTREE_PATH: worktreePath,
      CANOPY_PROJECT_ROOT: projectRootPath,
      CANOPY_WORKTREE_NAME: worktreeName,
    };
  }
}

function tailOutput(chunks: string[]): string {
  const full = chunks.join("");
  if (full.length <= OUTPUT_TAIL_BYTES) {
    return full;
  }
  return "...(truncated)\n" + full.slice(full.length - OUTPUT_TAIL_BYTES);
}
