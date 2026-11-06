// eager-import-allow: reads the global command environment via store.get only during a requested project command, after dynamically importing the store
/**
 * Runs one non-interactive shell command in a project root or one of its
 * worktrees and reports its exit code, output and timing (#13495) — the shell a
 * hub assistant has no access to on a host it only reaches over a relay.
 *
 * Process handling is `boundedProcess.ts`, the same core `project.runCheck`
 * runs on; this service owns what differs: the command comes from the caller,
 * several may run in one directory, and the environment is built for a command
 * an assistant chose rather than one the project declares.
 *
 * The cwd check decides where a command starts, not what it can reach. It runs
 * as the host's user with that user's access; who may call it at all is
 * decided where the MCP call is answered.
 */

import {
  PROJECT_COMMAND_DEFAULT_TIMEOUT_MS,
  PROJECT_COMMAND_MAX_CONCURRENT,
  PROJECT_COMMAND_MAX_OUTPUT_BYTES,
  PROJECT_COMMAND_MAX_TIMEOUT_MS,
  PROJECT_COMMAND_MIN_TIMEOUT_MS,
  type ProjectCommandRunArgs,
  type ProjectCommandRunResult,
} from "../../shared/types/projectCommand.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { buildInstallEnv } from "../utils/spawnEnv.js";
import { runBoundedProcess, type BoundedProcessSlot } from "./boundedProcess.js";
import { resolveProjectCwd } from "./projectCwd.js";

/**
 * Thrown when a command could not be started at all — unknown project,
 * unusable directory, the host at its concurrency bound, or shutdown. Distinct
 * from a command that ran and exited non-zero, which is a normal result.
 */
export class ProjectCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectCommandError";
  }
}

/** The environment variables the user configured for terminal launches. */
export interface ProjectCommandEnvLayers {
  global: Record<string, string>;
  project: Record<string, string>;
}

export interface ProjectCommandServiceDeps {
  getProject(projectId: string): Promise<{ id: string; path: string } | null>;
  getEnvLayers(projectId: string): Promise<ProjectCommandEnvLayers>;
}

/** The global and project variables the user configured for terminals. */
export async function readProjectCommandEnvLayers(
  projectId: string
): Promise<ProjectCommandEnvLayers> {
  const [{ projectStore }, { store }] = await Promise.all([
    import("./ProjectStore.js"),
    import("../store.js"),
  ]);
  return {
    global: store.get("globalEnvironmentVariables") ?? {},
    project:
      (
        await projectStore.getProjectSettings(projectId).catch((error: unknown) => {
          console.warn(
            "[ProjectCommandService] Couldn't read project settings; running without project env:",
            error
          );
          return null;
        })
      )?.environmentVariables ?? {},
  };
}

const liveDeps: ProjectCommandServiceDeps = {
  getProject: async (projectId) => {
    const { projectStore } = await import("./ProjectStore.js");
    return projectStore.getProjectById(projectId);
  },
  getEnvLayers: readProjectCommandEnvLayers,
};

/**
 * Ambient variables passed through beyond the install allowlist: the SSH agent
 * socket, so `git fetch` over SSH can use a key the agent holds, and the
 * Windows shell and system paths `cmd.exe` resolves through.
 */
const EXTRA_INHERITED_KEYS = new Set(["SSH_AUTH_SOCK", "COMSPEC", "WINDIR"]);

/**
 * Stripped after every layer is merged, whoever set them. `DAINTREE_*` is the
 * one that matters most: the host's MCP bearers live in that namespace
 * (`DAINTREE_MCP_TOKEN`, a plugin's endpoint token), and a command an
 * assistant typed must never be able to read the credential it is calling
 * through. The rest are loader and git hooks that would run code of their own
 * inside every command.
 */
const DENIED_KEYS = new Set([
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_EXEC_PATH",
]);
const DENIED_PREFIXES = ["DAINTREE_", "LD_", "DYLD_", "GIT_CONFIG_"];

function isDeniedKey(key: string): boolean {
  const upper = key.toUpperCase();
  return DENIED_KEYS.has(upper) || DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  CI: "1",
  NONINTERACTIVE: "1",
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  DEBIAN_FRONTEND: "noninteractive",
  PAGER: "cat",
  GIT_PAGER: "cat",
  NO_COLOR: "1",
};

/**
 * Windows treats variable names case-insensitively, and given two spellings of
 * one name (`Path` from the process, `PATH` from a project) Node forwards
 * whichever sorts first, not the later layer. So a later layer replaces every
 * spelling of a name there, and precedence holds.
 */
function setVariable(
  env: Record<string, string>,
  key: string,
  value: string,
  caseInsensitive: boolean
): void {
  if (caseInsensitive) {
    const upper = key.toUpperCase();
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toUpperCase() === upper) delete env[existing];
    }
  }
  env[key] = value;
}

/**
 * The environment a command runs with: the install allowlist (PATH, HOME,
 * locale, proxy and CA settings, version-manager roots), the SSH agent socket,
 * then the global and project variables the user configured for terminals,
 * with Daintree's own namespace and code-injecting variables removed and
 * non-interactive markers forced last so nothing can wait on a prompt.
 *
 * Nothing else is inherited from Daintree's process: a token in its
 * environment never reaches a command unless the user put it in a project's
 * or the global environment variables.
 */
export function buildProjectCommandEnv(
  layers: ProjectCommandEnvLayers | null,
  ambient: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const caseInsensitive = platform === "win32";
  const env: Record<string, string> = { ...buildInstallEnv() };
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined && EXTRA_INHERITED_KEYS.has(key.toUpperCase())) {
      setVariable(env, key, value, caseInsensitive);
    }
  }
  for (const layer of [layers?.global, layers?.project, NON_INTERACTIVE_ENV]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      setVariable(env, key, value, caseInsensitive);
    }
  }
  for (const key of Object.keys(env)) {
    if (isDeniedKey(key)) delete env[key];
  }
  return env;
}

function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return PROJECT_COMMAND_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(
    PROJECT_COMMAND_MAX_TIMEOUT_MS,
    Math.max(PROJECT_COMMAND_MIN_TIMEOUT_MS, Math.floor(requested))
  );
}

export class ProjectCommandService {
  private readonly active = new Set<BoundedProcessSlot>();
  private disposed = false;

  constructor(private readonly deps: ProjectCommandServiceDeps = liveDeps) {}

  /**
   * Resolve, admit, and run one command.
   *
   * @throws {ProjectCommandError} when no run could be started. A command
   * that started and then failed, timed out, or was cancelled resolves
   * normally with the corresponding flags set.
   */
  async run(
    args: ProjectCommandRunArgs,
    options?: {
      signal?: AbortSignal;
      /**
       * Asked once more right before the spawn, after every await: throws to
       * refuse. A command relayed from another machine (#13493) may run only
       * while that machine still drives the project.
       */
      authorize?: () => void;
    }
  ): Promise<ProjectCommandRunResult> {
    this.assertOpen();

    const project = await this.deps.getProject(args.projectId);
    if (!project) {
      throw new ProjectCommandError(
        `No project found with id "${args.projectId}". Use project.getAll to list open projects.`
      );
    }

    const createError = (message: string) => new ProjectCommandError(message);
    const cwd = await resolveProjectCwd(project.path, args.cwd, createError);
    const layers = await this.deps.getEnvLayers(project.id).catch((err: unknown) => {
      console.warn(
        "[ProjectCommandService] Could not read environment variables:",
        formatErrorMessage(err, "unknown error")
      );
      return null;
    });

    if (options?.signal?.aborted) {
      throw new ProjectCommandError("Cancelled before the command started.");
    }
    // Re-checked after the awaits above: `dispose()` only aborts what is
    // already admitted, so a command must not spawn detached after it ran.
    this.assertOpen();
    // With no await between this and the spawn.
    options?.authorize?.();
    if (this.active.size >= PROJECT_COMMAND_MAX_CONCURRENT) {
      throw new ProjectCommandError(
        `${PROJECT_COMMAND_MAX_CONCURRENT} commands are already running on this host. Wait for one to finish before starting another.`
      );
    }

    // Admitted synchronously, before the first await inside the run, so
    // concurrent callers can never all pass the bound together.
    const slot: BoundedProcessSlot = { abort: () => {}, abortNow: () => {} };
    this.active.add(slot);
    const startedAt = Date.now();
    try {
      const outcome = await runBoundedProcess({
        command: args.command,
        cwd,
        env: () => buildProjectCommandEnv(layers),
        timeoutMs: clampTimeout(args.timeoutMs),
        maxOutputBytes: PROJECT_COMMAND_MAX_OUTPUT_BYTES,
        label: "command",
        logPrefix: "[ProjectCommandService]",
        signal: options?.signal,
        slot,
        createError,
      });
      return {
        projectId: project.id,
        cwd,
        exitCode: outcome.exitCode,
        signalName: outcome.signalName,
        durationMs: Date.now() - startedAt,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        output: outcome.output,
        outputTruncated: outcome.outputTruncated,
      };
    } finally {
      this.active.delete(slot);
    }
  }

  /**
   * Kill every command still running. Called from the app shutdown chain:
   * POSIX children are spawned detached, so an unreaped one outlives the app.
   * Synchronous by design, like `ProjectCheckService.dispose`.
   */
  dispose(): void {
    this.disposed = true;
    for (const slot of this.active) {
      try {
        slot.abortNow();
      } catch (err) {
        console.warn(
          "[ProjectCommandService] abort during dispose failed:",
          formatErrorMessage(err, "unknown error")
        );
      }
    }
    this.active.clear();
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new ProjectCommandError("Daintree is shutting down; no new commands can start.");
    }
  }
}

export const projectCommandService = new ProjectCommandService();
