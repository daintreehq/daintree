import { execFile, execFileSync } from "child_process";
import { access, constants } from "fs/promises";
import { delimiter, dirname, join } from "path";
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
import { listFirstWslDistro } from "../utils/wsl.js";

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
 * directory. `where.exe` returns both `claude.cmd` and `claude.exe` for a
 * single npm-global install — counting them as two installations would
 * false-positive the duplicate-detection notification. Comparison is
 * case-insensitive on Windows to mirror NTFS path semantics
 * (matches `electron/setup/environment.ts:128`).
 */
function dedupePathsByDirectory(paths: string[], isWindows: boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const dir = dirname(p);
    const key = isWindows ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
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

        const checksPromise = Promise.allSettled(
          entries.map(async ([id, config]) => {
            const outcome = await this.checkAgent(config);
            return [id, outcome] as [string, AgentCheckOutcome];
          })
        );

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("CLI availability check timed out")),
            CliAvailabilityService.CHECK_TIMEOUT_MS
          );
        });

        let outcomeEntries: [string, AgentCheckOutcome][];
        try {
          const results = await Promise.race([checksPromise, timeoutPromise]);
          outcomeEntries = results.map((result, index) => {
            if (result.status === "fulfilled") {
              return result.value;
            } else {
              console.warn(
                `[CliAvailabilityService] Check failed for ${entries[index][0]}:`,
                result.reason
              );
              return [
                entries[index][0],
                {
                  state: "missing" as AgentAvailabilityState,
                  detail: {
                    state: "missing" as AgentAvailabilityState,
                    resolvedPath: null,
                    via: null,
                  },
                },
              ];
            }
          });
        } catch (error) {
          // eslint-disable-next-line no-restricted-syntax -- diagnostic console.warn passes the raw error if not an Error; not a user-visible string.
          console.warn("[CliAvailabilityService]", error instanceof Error ? error.message : error);
          outcomeEntries = entries.map(([id]) => [
            id,
            {
              state: "missing" as AgentAvailabilityState,
              detail: {
                state: "missing" as AgentAvailabilityState,
                resolvedPath: null,
                via: null,
              },
            },
          ]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }

        const availability: CliAvailability = Object.fromEntries(
          outcomeEntries.map(([id, outcome]) => [id, outcome.state])
        );
        const details: AgentCliDetails = Object.fromEntries(
          outcomeEntries.map(([id, outcome]) => [id, outcome.detail])
        );

        if (this.checkId === currentCheckId) {
          this.availability = availability;
          this.details = details;
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
      ? await this.checkAuth(config.name, config.authCheck)
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

  private async checkAuth(agentName: string, authCheck: AgentAuthCheck): Promise<boolean> {
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
        console.log(
          `[CliAvailabilityService] ${agentName}: binary found, auth discovery: no credential found (checked: ${
            checkedPaths.join(", ") || "none"
          })`
        );
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
   * 3. npm global bin shim at `$(npm config get prefix)/bin/<cmd>` (POSIX) or
   *    `<prefix>\<cmd>.cmd` (Windows). Only fires when
   *    `AgentConfig.npmGlobalPackage` is set. Positively confirms the binary
   *    was installed via `npm install -g` — supersedes the prior npx-cache
   *    probe which false-positively reported "ready" whenever the package had
   *    been executed once via `npx <pkg>`, populating `~/.npm/_npx` without
   *    installing a launchable bin shim (issue #5641).
   * 4. WSL probe on Windows — only fires when `AgentConfig.supportsWsl` is
   *    true. Probes `wsl.exe --list --quiet` then `wsl.exe -d <distro> -e
   *    <cmd> --version` against the first listed distribution.
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
    if (!CliAvailabilityService.VALID_COMMAND_RE.test(command)) {
      console.warn(
        `[CliAvailabilityService] Command "${command}" contains invalid characters, rejecting`
      );
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
        ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
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

  private probeViaShell(command: string): Promise<ProbeResult> {
    return new Promise((resolve) => {
      setImmediate(() => {
        const isWindows = process.platform === "win32";
        const checkCmd = isWindows ? "where" : "which";
        // `where.exe` already prints every PATH match. On Unix, request all
        // matches via `which -a` to drive duplicate detection (#6054). When
        // `-a` is rejected by a minimal `which` (e.g. older BusyBox), retry
        // without the flag so duplicate detection degrades to a single-path
        // lookup rather than reporting the agent as missing.
        const runWhich = (
          extraArgs: string[]
        ): { ok: true; lines: string[] } | { ok: false; err: unknown } => {
          try {
            const buffer = execFileSync(checkCmd, [...extraArgs, command], {
              stdio: ["ignore", "pipe", "ignore"],
              timeout: CliAvailabilityService.WHICH_TIMEOUT_MS,
            });
            const output = buffer.toString("utf8").trim();
            const lines = output
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            return { ok: true, lines };
          } catch (err) {
            return { ok: false, err };
          }
        };

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

        const primary = runWhich(isWindows ? [] : ["-a"]);
        if (primary.ok) {
          if (primary.lines.length === 0) {
            // Some shells exit 0 with empty stdout. Preserve the historical
            // contract: fall back to the bare command so the binary is still
            // launchable via PATH lookup at spawn time.
            resolve({ status: "found", path: command, via: "which" });
            return;
          }
          const allPaths = dedupePathsByDirectory(primary.lines, isWindows);
          resolve({ status: "found", path: allPaths[0], via: "which", allPaths });
          return;
        }

        // Non-zero exit. On Unix this can be BusyBox/minimal `which`
        // rejecting `-a`; retry without the flag so a real install isn't
        // misreported as missing. Skip for security errors so the blocked
        // verdict surfaces directly.
        const primaryBlocked = classifyError(primary.err);
        if (primaryBlocked) {
          resolve(primaryBlocked);
          return;
        }
        if (!isWindows) {
          const fallback = runWhich([]);
          if (fallback.ok) {
            const path = fallback.lines[0] ?? command;
            resolve({ status: "found", path, via: "which" });
            return;
          }
          const fallbackBlocked = classifyError(fallback.err);
          if (fallbackBlocked) {
            resolve(fallbackBlocked);
            return;
          }
        }
        resolve({ status: "missing" });
      });
    });
  }

  private async probeNativePaths(paths: string[]): Promise<ProbeResult> {
    const home = homedir();
    for (const raw of paths) {
      const expanded = this.expandPath(raw, home);
      if (!expanded) continue;
      try {
        await access(expanded, constants.X_OK);
        return { status: "found", path: expanded, via: "native" };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
          // File exists but cannot be executed — classify as blocked and
          // stop probing remaining native paths. Trying other paths would
          // likely hit the same policy.
          return {
            status: "blocked",
            reason: code === "EACCES" ? "permissions" : "security",
            path: expanded,
            via: "native",
            message: `${expanded} exists but execution failed with ${code} — check file permissions or security software allowlist`,
          };
        }
        // ENOENT (or any other error) — try the next candidate.
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
      execFile(
        "npm",
        ["config", "get", "prefix"],
        {
          timeout: CliAvailabilityService.NPM_PREFIX_TIMEOUT_MS,
          windowsHide: true,
        },
        async (err, stdout) => {
          if (err) {
            resolve({ status: "missing" });
            return;
          }
          const prefix = String(stdout ?? "").trim();
          if (!prefix || prefix === "undefined") {
            resolve({ status: "missing" });
            return;
          }

          // Guard against a prefix that would slip by `path.join` — the
          // command name is already validated against VALID_COMMAND_RE, but
          // defensively reject a prefix containing NUL bytes (fs.access would
          // throw) rather than passing it through.
          if (prefix.includes("\0")) {
            resolve({ status: "missing" });
            return;
          }

          const shimPath =
            process.platform === "win32"
              ? join(prefix, `${command}.cmd`)
              : join(prefix, "bin", command);

          try {
            await access(shimPath, constants.X_OK);
            resolve({ status: "found", path: shimPath, via: "npm-global" });
          } catch (accessErr) {
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
          }
        }
      );
    });
  }

  private async probeWsl(command: string): Promise<ProbeResult> {
    const distro = await listFirstWslDistro();
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
      // "%LOCALAPPDATA%\claude-code\bin\claude.exe".
      if (expanded.includes("%")) return null;
    } else if (expanded.includes("\\")) {
      // Windows-only candidates should not be probed on Unix.
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
        console.warn(
          `[CliAvailabilityService] Failed to broadcast duplicate-install toast for ${agentId}:`,
          err
        );
        continue;
      }

      milestones = { ...milestones, [milestoneKey]: true };
      dirty = true;
    }

    if (dirty) {
      try {
        store.set("orchestrationMilestones", milestones);
      } catch (err) {
        console.warn(
          "[CliAvailabilityService] Failed to persist duplicate-install milestone:",
          err
        );
      }
    }
  }
}
