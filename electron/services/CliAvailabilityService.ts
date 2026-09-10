// eager-import-allow: reads the CLI-availability cache via store.get synchronously
import { execFile } from "child_process";
import { access, constants } from "fs/promises";
import { delimiter, dirname, isAbsolute, join, win32 as pathWin32 } from "path";
import { homedir } from "os";
import type {
  CliAvailability,
  AgentAvailabilityState,
  AgentCliDetail,
  AgentCliDetails,
  AgentCliProbeSource,
} from "../../shared/types/ipc.js";
import {
  getEffectiveRegistry,
  type AgentConfig,
  type AgentAuthCheck,
} from "../../shared/config/agentRegistry.js";
import { refreshPath, expandWindowsEnvVars } from "../setup/environment.js";
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { getDefaultWslDistro } from "../utils/wsl.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("main:CliAvailabilityService");

interface ProbeSuccess {
  status: "found";
  path: string;
  via: AgentCliProbeSource;
  wslDistro?: string;
  /**
   * All resolved paths from a shell probe (`which -a` on Unix, `where.exe`
   * on Windows), deduplicated by directory. Populated only when the probe
   * succeeded via `which`; first entry equals {@link ProbeSuccess.path}.
   */
  allPaths?: string[];
}

interface ProbeMissing {
  status: "missing";
}

interface ProbeBlocked {
  status: "blocked";
  reason: "security" | "permissions";
  /** Optional path that was found but could not be executed (e.g. which succeeded, then spawn EPERM). */
  path?: string;
  /** Which layer produced the block verdict. */
  via?: AgentCliProbeSource;
  message: string;
}

type ProbeResult = ProbeSuccess | ProbeMissing | ProbeBlocked;

interface AgentCheckOutcome {
  state: AgentAvailabilityState;
  detail: AgentCliDetail;
}

const SECURITY_ERROR_CODES = new Set(["EACCES", "EPERM"]);

const CHECK_TIMED_OUT_MESSAGE = "The most recent check didn't finish in time.";

const WINDOWS_EXECUTABLE_PRIORITY = new Map<string, number>([
  [".cmd", 0],
  [".exe", 1],
  [".bat", 2],
  [".com", 3],
  [".ps1", 4],
  ["", 5],
]);

const WINDOWS_APPENDED_EXTENSIONS = [".cmd", ".exe", ".bat", ".com"];

/**
 * Synthesise probe paths for PyPI-distributed agents. Modern Python tool
 * installs land in well-known per-user locations: uv tool, pipx (current
 * and legacy layouts), and pip --user-shared `~/.local/bin`. We probe
 * those before falling back to the npm-global / WSL probes so a uv-installed
 * agent on a host without the tool dir on PATH still resolves.
 *
 * Returns paths in priority order. Tilde and `%VAR%` expansion is handled
 * downstream by `expandPath()`.
 */
function synthesisePypiProbePaths(command: string, pypiPackage: string): string[] {
  if (process.platform === "win32") {
    return [
      // uv tool publishes a launcher to `%USERPROFILE%\.local\bin\<cmd>.exe`
      `%USERPROFILE%\\.local\\bin\\${command}.exe`,
      // uv tool venv layout (Roaming AppData, since uv >= 0.4)
      `%APPDATA%\\uv\\tools\\${pypiPackage}\\Scripts\\${command}.exe`,
      // pipx ≥ 1.4 default on Windows: PIPX_HOME = %USERPROFILE%\.local\pipx
      `%USERPROFILE%\\.local\\pipx\\venvs\\${pypiPackage}\\Scripts\\${command}.exe`,
      // pipx legacy default on Windows (older releases)
      `%LOCALAPPDATA%\\pipx\\pipx\\venvs\\${pypiPackage}\\Scripts\\${command}.exe`,
    ];
  }
  return [
    // uv tool symlink + pip --user shared bin (also covers pipx ≥ 1.4 default)
    `~/.local/bin/${command}`,
    // uv tool venv bin
    `~/.local/share/uv/tools/${pypiPackage}/bin/${command}`,
    // pipx venv bin (modern path)
    `~/.local/share/pipx/venvs/${pypiPackage}/bin/${command}`,
    // pipx legacy path (kept for users on older pipx releases)
    `~/.local/pipx/venvs/${pypiPackage}/bin/${command}`,
  ];
}

/**
 * Collapse PATH-resolved binary candidates that live in the same install
 * directory. `where.exe` can return `claude`, `claude.cmd`, `claude.ps1`, and
 * `claude.exe` for a single npm-global install. Counting them as separate
 * installs false-positives duplicate detection, and keeping the extensionless
 * shim makes PowerShell execute a file that only echoes the shim path. Keep
 * the first directory order, but prefer launchable Windows wrappers inside a
 * directory. Comparison is case-insensitive on Windows to mirror NTFS path
 * semantics (matches `electron/setup/environment.ts:128`).
 */
function dedupePathsByDirectory(paths: string[], isWindows: boolean): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const p of paths) {
    const dir = isWindows ? pathWin32.dirname(p) : dirname(p);
    const key = isWindows ? dir.toLowerCase() : dir;
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (
        isWindows &&
        windowsExecutablePriority(p) < windowsExecutablePriority(out[existingIndex])
      ) {
        out[existingIndex] = p;
      }
      continue;
    }
    seen.set(key, out.length);
    out.push(p);
  }
  return out;
}

function windowsExecutablePriority(candidatePath: string): number {
  return WINDOWS_EXECUTABLE_PRIORITY.get(pathWin32.extname(candidatePath).toLowerCase()) ?? 6;
}

/**
 * `fs.access(X_OK)` is only an existence check on Windows, and the launcher
 * runs `resolvedPath` verbatim through PowerShell, so an extensionless file
 * there proves nothing launchable. Probe the executable variants instead, but
 * leave a path that already names a launchable extension alone so
 * `goose.exe` never turns into `goose.exe.cmd`.
 */
function windowsLaunchCandidates(filePath: string): string[] {
  const extension = pathWin32.extname(filePath).toLowerCase();
  if (extension && WINDOWS_EXECUTABLE_PRIORITY.has(extension)) return [filePath];
  return WINDOWS_APPENDED_EXTENSIONS.map((appended) => `${filePath}${appended}`);
}

export class CliAvailabilityService {
  private static readonly CHECK_TIMEOUT_MS = 10_000;
  private static readonly AUTH_CHECK_TIMEOUT_MS = 3_000;
  private static readonly WHICH_TIMEOUT_MS = 5_000;
  private static readonly NPM_PREFIX_TIMEOUT_MS = 4_000;
  private static readonly WSL_PROBE_TIMEOUT_MS = 8_000;
  private static readonly VALID_COMMAND_RE = /^[a-zA-Z0-9._-]+$/;

  private availability: CliAvailability | null = null;
  private details: AgentCliDetails | null = null;
  private inFlightCheck: Promise<CliAvailability> | null = null;
  private npmPrefixCache: { promise: Promise<string | null>; checkId: number } | null = null;
  private checkId = 0;

  async checkAvailability(): Promise<CliAvailability> {
    if (this.inFlightCheck) {
      return this.inFlightCheck;
    }

    const currentCheckId = this.checkId;

    this.inFlightCheck = (async () => {
      try {
        if (this.availability === null) {
          await refreshPath();
        }

        const entries = Object.entries(getEffectiveRegistry());

        // Outcomes are recorded as each agent settles, so an agent that
        // outlives the batch budget can't take the ones that already answered
        // down with it.
        const settled = new Map<string, AgentCheckOutcome>();
        const checksPromise = Promise.all(
          entries.map(async ([id, config]) => {
            try {
              settled.set(id, await this.checkAgent(config));
            } catch (error) {
              logger.error("Agent CLI check failed", error, { agentId: id });
              settled.set(id, {
                state: "missing",
                detail: { state: "missing", resolvedPath: null, via: null },
              });
            }
          })
        );

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(), CliAvailabilityService.CHECK_TIMEOUT_MS);
        });

        try {
          await Promise.race([checksPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }

        const pendingAgentIds: string[] = [];
        const outcomeEntries = entries.map(([id]): [string, AgentCheckOutcome] => {
          const outcome = settled.get(id);
          if (outcome) return [id, outcome];
          pendingAgentIds.push(id);
          // Running out of time says nothing about whether the binary is still
          // there, so reuse what the last published check reported and flag
          // that it wasn't re-confirmed — unless that detail already carries
          // its own diagnostic, which stays the more useful thing to show.
          const previous = this.details?.[id];
          if (previous) {
            return [
              id,
              {
                state: previous.state,
                detail: { ...previous, message: previous.message ?? CHECK_TIMED_OUT_MESSAGE },
              },
            ];
          }
          return [
            id,
            {
              state: "missing",
              detail: {
                state: "missing",
                resolvedPath: null,
                via: null,
                message: CHECK_TIMED_OUT_MESSAGE,
              },
            },
          ];
        });

        const availability: CliAvailability = Object.fromEntries(
          outcomeEntries.map(([id, outcome]) => [id, outcome.state])
        );
        const details: AgentCliDetails = Object.fromEntries(
          outcomeEntries.map(([id, outcome]) => [id, outcome.detail])
        );

        if (this.checkId === currentCheckId) {
          this.availability = availability;
          this.details = details;
          // Only a published check warns: a superseded one (the setup wizard
          // re-checks every 3s) would otherwise report results nobody sees.
          if (pendingAgentIds.length > 0) {
            logger.warn("CLI availability check timed out", {
              timeoutMs: CliAvailabilityService.CHECK_TIMEOUT_MS,
              pendingAgentIds,
            });
          }
          this.notifyDuplicateInstalls(outcomeEntries, entries);
        }

        return availability;
      } finally {
        if (this.checkId === currentCheckId) {
          this.inFlightCheck = null;
        }
      }
    })();

    return this.inFlightCheck;
  }

  getAvailability(): CliAvailability | null {
    return this.availability;
  }

  getDetails(): AgentCliDetails | null {
    return this.details;
  }

  async refresh(): Promise<CliAvailability> {
    await refreshPath();
    this.checkId++;
    this.inFlightCheck = null;
    return this.checkAvailability();
  }

  private async checkAgent(config: AgentConfig): Promise<AgentCheckOutcome> {
    const probe = await this.probeCommand(config);

    if (probe.status === "blocked") {
      return {
        state: "blocked",
        detail: {
          state: "blocked",
          resolvedPath: probe.path ?? null,
          via: probe.via ?? null,
          blockReason: probe.reason,
          message: probe.message,
        },
      };
    }

    if (probe.status === "missing") {
      return {
        state: "missing",
        detail: { state: "missing", resolvedPath: null, via: null },
      };
    }

    // WSL-detected agents are "installed" but NEVER "ready". Daintree's PTY
    // host spawns binaries directly — we cannot yet launch through wsl.exe.
    // Promoting to "ready" (e.g. because OPENAI_API_KEY is set) would make
    // the user click Codex and hit a silent ENOENT. Cap at "installed" and
    // attach a clear diagnostic so the Settings UI explains the gap.
    if (probe.via === "wsl") {
      return {
        state: "installed",
        detail: {
          state: "installed",
          resolvedPath: probe.path,
          via: "wsl",
          wslDistro: probe.wslDistro,
          message:
            "Detected in WSL — direct launch from Daintree on Windows isn't supported yet. Install a native Windows binary if available.",
        },
      };
    }

    // Binary found on PATH (or via native/npx) = launchable. Auth discovery
    // runs in parallel only to populate `authConfirmed` for onboarding UI.
    // When auth discovery explicitly returns false (credential check ran and
    // found nothing), classify as `unauthenticated` — the binary exists but
    // will require login on first launch. The CLI handles auth at runtime.
    const authConfirmed = config.authCheck
      ? await this.checkAuth(config.id, config.authCheck)
      : undefined;

    const state: AgentAvailabilityState = authConfirmed === false ? "unauthenticated" : "ready";

    return {
      state,
      detail: {
        state,
        resolvedPath: probe.path,
        via: probe.via,
        authConfirmed,
        // Only set when the shell probe surfaced multiple PATH matches —
        // single-install probes leave this undefined so consumers can
        // distinguish "not measured" from "exactly one install".
        ...(probe.allPaths && probe.allPaths.length > 1
          ? { allResolvedPaths: probe.allPaths }
          : {}),
      },
    };
  }

  private async checkAuth(agentId: string, authCheck: AgentAuthCheck): Promise<boolean> {
    // Shared flag so the checkPromise knows the timeoutPromise already won
    // the race. Without this, a slow fs.access can later resolve/reject and
    // emit a misleading "auth discovery: no credential found" log for an
    // agent whose result was actually determined by the timeout branch.
    let timedOut = false;
    // Track the timeout handle so we can clear it when checkPromise wins —
    // otherwise each fast-path success leaves an unresolved 3s timer pinned
    // to the event loop. Bounded leak per-refresh but worth avoiding.
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        // Timeout = check was inconclusive; treat as "not confirmed" so the
        // user sees the setup nudge rather than a silent green light.
        resolve(false);
      }, CliAvailabilityService.AUTH_CHECK_TIMEOUT_MS);
    });

    const checkPromise = (async (): Promise<boolean> => {
      const checkedPaths: string[] = [];

      // Check environment variable first (positive signal only)
      if (authCheck.envVar) {
        const envVars = Array.isArray(authCheck.envVar) ? authCheck.envVar : [authCheck.envVar];
        for (const envVar of envVars) {
          if (process.env[envVar]) {
            return true;
          }
        }
      }

      const home = homedir();

      // Check platform-specific config paths
      const platform = process.platform as "darwin" | "linux" | "win32";
      const platformPaths = authCheck.configPaths?.[platform];
      if (platformPaths) {
        for (const relPath of platformPaths) {
          const fullPath = join(home, relPath);
          checkedPaths.push(fullPath);
          try {
            await access(fullPath, constants.R_OK);
            return true;
          } catch {
            // File not found, continue
          }
        }
      }

      // Check platform-independent config paths
      if (authCheck.configPathsAll) {
        for (const relPath of authCheck.configPathsAll) {
          const fullPath = join(home, relPath);
          checkedPaths.push(fullPath);
          try {
            await access(fullPath, constants.R_OK);
            return true;
          } catch {
            // File not found, continue
          }
        }
      }

      if (!timedOut) {
        // Debug, not info: the setup wizard re-checks every 3s, and at info
        // this repeats into daintree.log's crash-context tail.
        logger.debug("Auth discovery found no credential", { agentId, checkedPaths });
      }
      return false;
    })();

    try {
      return await Promise.race([checkPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Layered binary probe. Tries in order:
   * 1. `which`/`where` against PATH (existing behavior, now capturing resolved
   *    path and classifying EACCES/EPERM errors as `blocked` instead of
   *    `missing`).
   * 2. Absolute paths declared in `AgentConfig.nativePaths` — covers native
   *    installer locations not on Electron's PATH (e.g. `~/.local/bin/claude`).
   *    On Windows an entry without a launchable extension is probed with
   *    `.cmd`/`.exe`/`.bat`/`.com` appended.
   * 3. npm global bin shim at `$(npm config get prefix)/bin/<cmd>` (POSIX) or
   *    `<prefix>\<cmd>.cmd` (Windows). Only fires when
   *    `AgentConfig.npmGlobalPackage` is set. Positively confirms the binary
   *    was installed via `npm install -g` — supersedes the prior npx-cache
   *    probe which false-positively reported "ready" whenever the package had
   *    been executed once via `npx <pkg>`, populating `~/.npm/_npx` without
   *    installing a launchable bin shim (issue #5641).
   * 4. WSL probe on Windows — only fires when `AgentConfig.supportsWsl` is
   *    true. Resolves the default distro via `wsl.exe --list --verbose` (the
   *    `*`-marked line) then probes `wsl.exe -d <distro> -e <cmd> --version`
   *    against it. Identifying the default by marker rather than list order
   *    matters on multi-distro hosts (issue #7944).
   *
   * A `blocked` result from the shell probe short-circuits the fallbacks:
   * the same endpoint security policy that blocked the PATH binary will
   * typically also block the native-path or npm-global binary, so probing
   * them would only mask the real problem.
   */
  private async probeCommand(config: AgentConfig): Promise<ProbeResult> {
    const command = config.command;
    if (typeof command !== "string" || !command.trim()) {
      return { status: "missing" };
    }
    // Plugin-contributed agents (#10560) resolve a `./`-relative manifest command
    // to an absolute path at registration. Such a command has path separators and
    // would be rejected by VALID_COMMAND_RE below, so probe the file directly
    // instead — `probeNativePaths` checks existence + executability (X_OK),
    // trying launchable extensions on Windows.
    if (isAbsolute(command)) {
      return this.probeNativePaths([command]);
    }
    if (!CliAvailabilityService.VALID_COMMAND_RE.test(command)) {
      logger.warn("Rejected agent command with invalid characters", { command });
      return { status: "missing" };
    }

    const prependedPathProbe = await this.probePrependedCliPath(command);
    if (prependedPathProbe.status !== "missing") {
      return prependedPathProbe;
    }

    const shellProbe = await this.probeViaShell(command);
    if (shellProbe.status !== "missing") {
      return shellProbe;
    }

    if (config.nativePaths && config.nativePaths.length > 0) {
      const nativeProbe = await this.probeNativePaths(config.nativePaths);
      if (nativeProbe.status !== "missing") {
        return nativeProbe;
      }
    }

    // Synthesise PyPI install paths (uv tool / pipx / pip --user) from
    // `packages.pypi`. Only fires when no `nativePaths` hit landed; agent
    // authors can still pin exact paths via `nativePaths` when the synthesised
    // set is wrong for their distribution. Runs before the npm-global probe
    // so a Python-distributed agent that also has an npm wrapper is detected
    // through its primary install path first.
    const pypiPackage = config.packages?.pypi;
    if (pypiPackage) {
      const pypiProbe = await this.probeNativePaths(synthesisePypiProbePaths(command, pypiPackage));
      if (pypiProbe.status !== "missing") {
        return pypiProbe;
      }
    }

    const npmPackage = config.packages?.npm ?? config.npmGlobalPackage;
    if (npmPackage) {
      const npmProbe = await this.probeNpmGlobal(command);
      if (npmProbe.status !== "missing") {
        return npmProbe;
      }
    }

    if (process.platform === "win32" && config.supportsWsl) {
      const wslProbe = await this.probeWsl(command);
      if (wslProbe.status !== "missing") {
        return wslProbe;
      }
    }

    return { status: "missing" };
  }

  private async probePrependedCliPath(command: string): Promise<ProbeResult> {
    const pathPrefix = process.env.DAINTREE_CLI_PATH_PREPEND;
    if (!pathPrefix) return { status: "missing" };

    const commandCandidates =
      process.platform === "win32"
        ? [...WINDOWS_APPENDED_EXTENSIONS.map((extension) => `${command}${extension}`), command]
        : [command];

    for (const dir of pathPrefix.split(delimiter).filter(Boolean)) {
      for (const candidate of commandCandidates) {
        const candidatePath = join(dir, candidate);
        try {
          await access(candidatePath, constants.X_OK);
          return { status: "found", path: candidatePath, via: "which" };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
            return {
              status: "blocked",
              reason: code === "EACCES" ? "permissions" : "security",
              path: candidatePath,
              via: "which",
              message: `${candidatePath} exists but execution failed with ${code} — check file permissions or security software allowlist`,
            };
          }
        }
      }
    }

    return { status: "missing" };
  }

  private async probeViaShell(command: string): Promise<ProbeResult> {
    const isWindows = process.platform === "win32";
    const checkCmd = isWindows ? "where" : "which";
    // `where.exe` already prints every PATH match. On Unix, request all
    // matches via `which -a` to drive duplicate detection (#6054). When
    // `-a` is rejected by a minimal `which` (e.g. older BusyBox), retry
    // without the flag so duplicate detection degrades to a single-path
    // lookup rather than reporting the agent as missing.
    const runWhich = (
      extraArgs: string[]
    ): Promise<{ ok: true; lines: string[] } | { ok: false; err: unknown }> =>
      new Promise((resolve) => {
        execFile(
          checkCmd,
          [...extraArgs, command],
          {
            timeout: CliAvailabilityService.WHICH_TIMEOUT_MS,
            windowsHide: true,
          },
          (err, stdout) => {
            if (err) {
              resolve({ ok: false, err });
              return;
            }
            const lines = String(stdout ?? "")
              .trim()
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            resolve({ ok: true, lines });
          }
        );
      });

    const classifyError = (err: unknown): ProbeResult | null => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      // EACCES / EPERM from which/where itself is rare — most endpoint
      // security blocks surface on the spawn attempt. Still, when they
      // do, the binary clearly exists on disk (otherwise we'd have
      // ENOENT) so "blocked" is the correct classification.
      if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
        return {
          status: "blocked",
          reason: "security",
          via: "which",
          message: `${checkCmd} "${command}" failed with ${code} — likely blocked by security software or missing execute permission`,
        };
      }
      return null;
    };

    const primary = await runWhich(isWindows ? [] : ["-a"]);
    if (primary.ok) {
      if (primary.lines.length === 0) {
        // Some shells exit 0 with empty stdout. Preserve the historical
        // contract: fall back to the bare command so the binary is still
        // launchable via PATH lookup at spawn time.
        return { status: "found", path: command, via: "which" };
      }
      const allPaths = dedupePathsByDirectory(primary.lines, isWindows);
      return { status: "found", path: allPaths[0], via: "which", allPaths };
    }

    // Non-zero exit. On Unix this can be BusyBox/minimal `which`
    // rejecting `-a`; retry without the flag so a real install isn't
    // misreported as missing. Skip for security errors so the blocked
    // verdict surfaces directly.
    const primaryBlocked = classifyError(primary.err);
    if (primaryBlocked) {
      return primaryBlocked;
    }
    if (!isWindows) {
      const fallback = await runWhich([]);
      if (fallback.ok) {
        const path = fallback.lines[0] ?? command;
        return { status: "found", path, via: "which" };
      }
      const fallbackBlocked = classifyError(fallback.err);
      if (fallbackBlocked) {
        return fallbackBlocked;
      }
    }
    return { status: "missing" };
  }

  private async probeNativePaths(paths: string[]): Promise<ProbeResult> {
    const home = homedir();
    const isWindows = process.platform === "win32";
    for (const raw of paths) {
      const expanded = this.expandPath(raw, home);
      if (!expanded) continue;
      const candidates = isWindows ? windowsLaunchCandidates(expanded) : [expanded];
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.X_OK);
          return { status: "found", path: candidate, via: "native" };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
            // File exists but cannot be executed — classify as blocked and
            // stop probing remaining native paths. Trying other paths would
            // likely hit the same policy.
            return {
              status: "blocked",
              reason: code === "EACCES" ? "permissions" : "security",
              path: candidate,
              via: "native",
              message: `${candidate} exists but execution failed with ${code} — check file permissions or security software allowlist`,
            };
          }
          // ENOENT (or any other error) — try the next candidate.
        }
      }
    }
    return { status: "missing" };
  }

  /**
   * Probe whether the agent's CLI is installed as a global npm bin shim.
   * Runs `npm config get prefix` to find npm's install prefix, then checks
   * for the bin shim at `<prefix>/bin/<command>` (POSIX) or
   * `<prefix>\<command>.cmd` (Windows). The presence of this file means
   * `<command>` is resolvable on the npm-global PATH — the same launch
   * contract the PTY host relies on when spawning the bare command.
   *
   * This replaces the earlier `npx --prefer-offline --no <pkg>` probe, which
   * succeeded on a hit in `~/.npm/_npx` (the ephemeral cache populated by any
   * prior `npx <pkg>` invocation) even when no global bin shim was installed —
   * producing "ready" states that led to silent launch failures (#5641).
   *
   * Error classification:
   * - `npm` missing from PATH or `npm config get prefix` failing → `missing`.
   *   A broken/absent npm install is not an endpoint-security scenario.
   * - Shim file EACCES/EPERM → `blocked` (same semantics as `probeNativePaths`).
   * - Shim file ENOENT → `missing`.
   */
  private probeNpmGlobal(command: string): Promise<ProbeResult> {
    return new Promise((resolve) => {
      const checkShim = (prefix: string | null) => {
        if (prefix === null) {
          resolve({ status: "missing" });
          return;
        }

        if (prefix.includes("\0")) {
          resolve({ status: "missing" });
          return;
        }

        const shimPath =
          process.platform === "win32"
            ? join(prefix, `${command}.cmd`)
            : join(prefix, "bin", command);

        access(shimPath, constants.X_OK)
          .then(() => {
            resolve({ status: "found", path: shimPath, via: "npm-global" });
          })
          .catch((accessErr) => {
            const code = (accessErr as NodeJS.ErrnoException | undefined)?.code;
            if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
              resolve({
                status: "blocked",
                reason: code === "EACCES" ? "permissions" : "security",
                path: shimPath,
                via: "npm-global",
                message: `${shimPath} exists but execution failed with ${code} — check file permissions or security software allowlist`,
              });
              return;
            }
            resolve({ status: "missing" });
          });
      };

      if (!this.npmPrefixCache || this.npmPrefixCache.checkId !== this.checkId) {
        this.npmPrefixCache = {
          checkId: this.checkId,
          promise: new Promise<string | null>((res) => {
            execFile(
              "npm",
              ["config", "get", "prefix"],
              {
                timeout: CliAvailabilityService.NPM_PREFIX_TIMEOUT_MS,
                windowsHide: true,
              },
              (err, stdout) => {
                if (err) {
                  res(null);
                  return;
                }
                const prefix = String(stdout ?? "").trim();
                if (!prefix || prefix === "undefined") {
                  res(null);
                  return;
                }
                res(prefix);
              }
            );
          }),
        };
      }

      this.npmPrefixCache.promise.then(checkShim);
    });
  }

  private async probeWsl(command: string): Promise<ProbeResult> {
    const distro = await getDefaultWslDistro();
    if (!distro) return { status: "missing" };

    return new Promise((resolve) => {
      execFile(
        "wsl.exe",
        ["-d", distro, "-e", command, "--version"],
        {
          timeout: CliAvailabilityService.WSL_PROBE_TIMEOUT_MS,
          windowsHide: true,
        },
        (err) => {
          if (!err) {
            resolve({
              status: "found",
              path: `wsl:${distro}`,
              via: "wsl",
              wslDistro: distro,
            });
            return;
          }
          resolve({ status: "missing" });
        }
      );
    });
  }

  private expandPath(input: string, home: string): string | null {
    if (!input) return null;
    let expanded = input;
    if (expanded.startsWith("~")) {
      expanded = join(home, expanded.slice(1));
    }
    if (process.platform === "win32") {
      expanded = expandWindowsEnvVars(expanded);
      // On Windows, skip entries that still contain unexpanded %VAR% tokens
      // (env var not set) to avoid probing a literal path like
      // "%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe".
      if (expanded.includes("%")) return null;
    } else if (input.includes("\\")) {
      // Windows-only candidates should not be probed on Unix. Inspect the
      // original input rather than `expanded`, since `join(home, …)` on a
      // Windows host can introduce backslashes even for posix-shaped inputs
      // (matters when tests mock `process.platform` to "darwin").
      return null;
    }
    return expanded;
  }

  /**
   * Surface a one-time toast per agent when the shell probe found multiple
   * PATH-resolved binaries (#6054). Multiple installs typically come from a
   * mix of Homebrew, npm-global, and native installer paths and can leave
   * the user confused about which copy is being launched.
   *
   * Persistence reuses `orchestrationMilestones` keyed by agent ID, so the
   * notification fires exactly once per agent across app restarts. A user
   * who consolidates their installs and triggers a re-check will not see
   * the toast again.
   */
  private notifyDuplicateInstalls(
    outcomeEntries: [string, AgentCheckOutcome][],
    registryEntries: [string, AgentConfig][]
  ): void {
    const configById = new Map(registryEntries);
    let milestones = store.get("orchestrationMilestones") ?? {};
    let dirty = false;

    for (const [agentId, outcome] of outcomeEntries) {
      const paths = outcome.detail.allResolvedPaths;
      if (!paths || paths.length <= 1) continue;

      const milestoneKey = `duplicate-cli-warning:${agentId}`;
      if (milestones[milestoneKey]) continue;

      const config = configById.get(agentId);
      const agentName = config?.name ?? agentId;
      const [active, ...others] = paths;
      const PREVIEW_LIMIT = 2;
      const preview = others.slice(0, PREVIEW_LIMIT).join(", ");
      const remainder = others.length - PREVIEW_LIMIT;
      const alsoFound = remainder > 0 ? `${preview}, and ${remainder} more` : preview;

      try {
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: "warning",
          title: `Multiple ${agentName} installations found`,
          message: `Active: ${active}. Also found: ${alsoFound}. Pick one install method and remove the others so the most up-to-date version launches.`,
        });
      } catch (err) {
        logger.error("Failed to broadcast duplicate-install toast", err, { agentId });
        continue;
      }

      milestones = { ...milestones, [milestoneKey]: true };
      dirty = true;
    }

    if (dirty) {
      try {
        store.set("orchestrationMilestones", milestones);
      } catch (err) {
        logger.error("Failed to persist duplicate-install milestone", err);
      }
    }
  }
}
