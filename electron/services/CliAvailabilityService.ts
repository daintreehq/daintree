// eager-import-allow: reads the CLI-availability cache via store.get synchronously
import { execFile } from "child_process";
import { access, constants, realpath } from "fs/promises";
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
  type AgentAccountDeclaration,
} from "../../shared/config/agentRegistry.js";
import { refreshPath, expandWindowsEnvVars } from "../setup/environment.js";
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer, hasBroadcastAudience } from "../ipc/utils.js";
import { getDefaultWslDistro } from "../utils/wsl.js";
import { findAllOnPath } from "../utils/findOnPath.js";
import { createProbeLimiter } from "../utils/probeLimiter.js";
import {
  findWindowsCommand,
  scanWindowsPath,
  windowsSystemTool,
} from "../utils/windowsExecutable.js";
import { cliSpawnTarget } from "../utils/windowsCliSpawn.js";
import { createLogger } from "../utils/logger.js";
import { seedAgentToolbarPinsIfUnset } from "./agentToolbarPins.js";
import { isAgentLaunchable } from "../../shared/utils/agentAvailability.js";

const logger = createLogger("main:CliAvailabilityService");

interface ProbeSuccess {
  status: "found";
  path: string;
  via: AgentCliProbeSource;
  wslDistro?: string;
  /**
   * All resolved paths from the PATH probe (an in-process walk on POSIX,
   * deduplicated by the file each resolves to; an in-process PATH search on
   * Windows, deduplicated by directory). Populated only when the probe
   * succeeded via the PATH layer; first entry equals {@link ProbeSuccess.path}.
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

const CHOSEN_COPY_MISSING_MESSAGE =
  "The copy chosen to launch isn't there any more. Choose another copy or use the default.";

/** The copy chosen for each agent, keeping only entries that can name one. */
function readCliChoices(): Record<string, string> {
  const stored: unknown = store.get("agentCliChoices");
  if (!stored || typeof stored !== "object") return {};
  const choices: Record<string, string> = {};
  for (const [agentId, path] of Object.entries(stored)) {
    if (typeof path === "string" && path.length > 0) choices[agentId] = path;
  }
  return choices;
}

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
 * File lookups for listing an agent's copies. One thread at most, so a location on
 * a hung mount can't take the pool's four a page opening at a time. Not the PATH
 * search's slots: losing those to this optional listing would read as every agent
 * missing from then on.
 */
const copyLookups = createProbeLimiter(1);

/**
 * Whether `p` names one location wherever it is resolved from. On Windows
 * `isAbsolute` also accepts `\x` and `/x`, which land on whichever drive is
 * current, so only a drive-qualified (`C:\x`) or UNC (`\\server\share`) path
 * counts there.
 */
export function isFullyQualifiedPath(
  p: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "win32") return isAbsolute(p);
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/**
 * The declared native paths this platform can read. A `/x` entry names no drive
 * on Windows, so it would land on whichever one is current, where any local user
 * can create the folder.
 */
function probedNativePaths(config: AgentConfig): string[] {
  const paths = config.nativePaths ?? [];
  return process.platform === "win32" ? paths.filter((entry) => !entry.startsWith("/")) : paths;
}

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
 * directory. One npm-global install can hold `claude`, `claude.cmd`,
 * `claude.ps1`, and `claude.exe`. Counting them as separate
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

/**
 * What makes two found paths one copy: the file they resolve to, so a symlink and
 * its target are not two installs. Windows folds case, and also counts the found
 * path's directory, since one install there is `claude.cmd` beside `claude.exe`
 * (see {@link dedupePathsByDirectory}). Links into one shared directory stay apart.
 */
async function copyIdentities(candidate: string, signal: AbortSignal): Promise<string[]> {
  const file = await copyLookups.withSlot(() => realpath(candidate), signal).catch(() => candidate);
  if (process.platform !== "win32") return [file];
  return [file.toLowerCase(), `${pathWin32.dirname(candidate).toLowerCase()}\\`];
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
  private availabilityCheckedAt: number | null = null;
  private availabilityRegistry: Record<string, AgentConfig> | null = null;
  private pendingRefreshes = 0;
  private inFlightCheck: Promise<CliAvailability> | null = null;
  private npmPrefixCache: { promise: Promise<string | null>; checkId: number } | null = null;
  private checkId = 0;
  /** Counts choices of which copy launches; see {@link getSettledDetails}. */
  private choiceEpoch = 0;
  /** The choices the published details have seen. */
  private publishedChoiceEpoch = 0;
  /**
   * Duplicate-install warnings already broadcast in THIS process.
   *
   * The persisted milestone alone cannot carry the guarantee: every call reads
   * `orchestrationMilestones` fresh at the top, so two availability passes that
   * overlap before the first `store.set` lands both see an empty map and both
   * broadcast. That put the same warning in the notification centre twice,
   * which costs the user the one thing the inbox is for — telling them how many
   * things actually need them.
   *
   * Marked synchronously, before the broadcast, so the window closes.
   */
  private readonly notifiedDuplicateInstalls = new Set<string>();

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

        const registry = getEffectiveRegistry();
        const entries = Object.entries(registry);
        const choices = readCliChoices();
        const choiceEpoch = this.choiceEpoch;
        // Whatever this check can't confirm still names the chosen copy, so a
        // launch never falls back to whichever copy PATH reaches first.
        const chosen = (id: string) =>
          Object.hasOwn(choices, id) ? { chosenPath: choices[id] } : {};

        // Outcomes are recorded as each agent settles, so an agent that
        // outlives the batch budget can't take the ones that already answered
        // down with it.
        const settled = new Map<string, AgentCheckOutcome>();
        const checksPromise = Promise.all(
          entries.map(async ([id, config]) => {
            try {
              settled.set(id, await this.checkAgent(config, chosen(id).chosenPath));
            } catch (error) {
              logger.error("Agent CLI check failed", error, { agentId: id });
              settled.set(id, {
                state: "missing",
                detail: { state: "missing", resolvedPath: null, via: null, ...chosen(id) },
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
          // Unless the choice changed since: a launch path read for another choice
          // would start the wrong copy.
          if (previous && previous.chosenPath === chosen(id).chosenPath) {
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
                ...chosen(id),
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
          // A check that ran out of time only partly answered, so it must not
          // stand in for a later one.
          this.availabilityCheckedAt = pendingAgentIds.length === 0 ? Date.now() : null;
          this.availabilityRegistry = registry;
          this.publishedChoiceEpoch = choiceEpoch;
          // Only a published check warns: a superseded one (the setup wizard
          // re-checks every 3s) would otherwise report results nobody sees.
          if (pendingAgentIds.length > 0) {
            logger.warn("CLI availability check timed out", {
              timeoutMs: CliAvailabilityService.CHECK_TIMEOUT_MS,
              pendingAgentIds,
            });
          }
          this.notifyDuplicateInstalls(outcomeEntries, entries);
          if (pendingAgentIds.length === 0) this.seedToolbarPins(availability);
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

  /**
   * The last published availability when it can stand in for a new check: a
   * complete check younger than `maxAgeMs`, probed against the registry still
   * in effect (the memoized registry is replaced on every agent add, removal or
   * config change), with no check or refresh under way that will replace it.
   */
  getFreshAvailability(maxAgeMs: number): CliAvailability | null {
    if (this.availability === null || this.availabilityCheckedAt === null) return null;
    if (this.inFlightCheck || this.pendingRefreshes > 0) return null;
    if (this.availabilityRegistry !== getEffectiveRegistry()) return null;
    if (Date.now() - this.availabilityCheckedAt >= maxAgeMs) return null;
    return this.availability;
  }

  getDetails(): AgentCliDetails | null {
    return this.details;
  }

  /**
   * The published details once they have seen every choice of which copy
   * launches. Until a check begun after a choice publishes, the details still
   * name the copy that launched before it, so anything about to launch, or to
   * describe what launches, reads through this.
   */
  async getSettledDetails(): Promise<AgentCliDetails | null> {
    // Each pass waits on a check that has seen the choice; one superseded by a
    // newer check leaves that one to wait on, and three passes bound the rest.
    for (let pass = 0; pass < 3 && this.publishedChoiceEpoch < this.choiceEpoch; pass++) {
      await this.checkAvailability().catch(() => {});
    }
    return this.details;
  }

  /**
   * Records the copy launches start for an agent, or with `null` returns it to
   * whichever copy detection finds first. Takes effect with the next check, so
   * follow it with {@link refresh}; until that publishes,
   * {@link getSettledDetails} waits. The caller vouches that `path` is one
   * {@link findCopies} returned.
   */
  setChosenCopy(agentId: string, path: string | null): void {
    const choices = readCliChoices();
    if (path === null) {
      if (!Object.hasOwn(choices, agentId)) return;
      delete choices[agentId];
    } else {
      choices[agentId] = path;
    }
    store.set("agentCliChoices", choices);
    this.choiceEpoch++;
    // A check begun before the choice would publish the copy it replaced.
    this.checkId++;
    this.inFlightCheck = null;
  }

  async refresh(): Promise<CliAvailability> {
    // Counted across the PATH refresh: an older check can still publish during
    // it, and must not read as reusable while this one is about to replace it.
    // From `checkId++` on, the new check's `inFlightCheck` covers the rest.
    this.pendingRefreshes++;
    try {
      await refreshPath();
    } finally {
      this.pendingRefreshes--;
    }
    this.checkId++;
    this.inFlightCheck = null;
    return this.checkAvailability();
  }

  /**
   * Every copy of an agent's CLI on this machine, the one launches start first.
   * Empty unless the last check found a launchable copy, or a chosen copy that
   * can't launch now, which leaves the others to choose from.
   *
   * A check stops at the first layer that answers, so this goes through all of
   * them. It stays out of the check because the npm layer spawns npm, which the
   * startup probe has no reason to pay for on every machine with an agent on PATH.
   *
   * Only ever adds to the launching copy, so a location that never answers costs
   * the copies behind it and not the one that matters most.
   */
  async findCopies(agentId: string, config: AgentConfig): Promise<string[]> {
    if (this.details === null) await this.checkAvailability();
    const detail = (await this.getSettledDetails())?.[agentId];
    const launchPath = detail && isAgentLaunchable(detail.state) ? detail.resolvedPath : null;
    if (!launchPath && detail?.chosenPath === undefined) return [];

    const copies = launchPath ? [launchPath] : [];
    const deadline = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        deadline.abort();
        resolve();
      }, CliAvailabilityService.CHECK_TIMEOUT_MS);
    });
    const collected = this.collectCopies(config, launchPath, copies, deadline.signal).catch(
      (error: unknown) => {
        if (!deadline.signal.aborted) {
          logger.warn("Couldn't finish listing CLI copies", { agentId, error: String(error) });
        }
      }
    );
    try {
      await Promise.race([collected, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    return [...copies];
  }

  /**
   * Appends to `copies` as each is confirmed, so a deadline keeps what was found by
   * then, and nothing new starts once it has passed.
   */
  private async collectCopies(
    config: AgentConfig,
    launchPath: string | null,
    copies: string[],
    signal: AbortSignal
  ): Promise<void> {
    const seen = new Set(launchPath ? await copyIdentities(launchPath, signal) : []);
    const add = async (candidate: string): Promise<void> => {
      const identities = await copyIdentities(candidate, signal);
      if (signal.aborted || identities.some((identity) => seen.has(identity))) return;
      for (const identity of identities) seen.add(identity);
      copies.push(candidate);
    };

    const command = config.command;
    // Waiting behind a hung lookup can use up the deadline before any layer starts.
    if (signal.aborted) return;
    // An absolute plugin command names its one file and has no layers to search.
    if (isAbsolute(command) || !CliAvailabilityService.VALID_COMMAND_RE.test(command)) return;

    const onPath = await this.probeViaShell(command);
    if (onPath.status === "found") {
      for (const candidate of onPath.allPaths ?? [onPath.path]) await add(candidate);
    }

    const pypiPackage = config.packages?.pypi;
    const fixedPaths = [
      ...probedNativePaths(config),
      ...(pypiPackage ? synthesisePypiProbePaths(command, pypiPackage) : []),
    ];
    for (const fixedPath of fixedPaths) {
      const probe = await copyLookups.withSlot(() => this.probeNativePaths([fixedPath]), signal);
      if (probe.status === "found") await add(probe.path);
    }

    if (config.packages?.npm ?? config.npmGlobalPackage) {
      const probe = await copyLookups.withSlot(() => this.probeNpmGlobal(command), signal);
      if (probe.status === "found") await add(probe.path);
    }
  }

  /** A fresh install's first pins come from this machine's first complete check (#14702). */
  private seedToolbarPins(availability: CliAvailability): void {
    try {
      seedAgentToolbarPinsIfUnset(availability);
    } catch (error) {
      logger.warn("Couldn't seed the toolbar's first agent pins", { error: String(error) });
    }
  }

  /**
   * A chosen copy is checked where it is and nowhere else: finding the CLI
   * somewhere else would launch a copy the user didn't choose.
   */
  private async checkAgent(config: AgentConfig, chosenPath?: string): Promise<AgentCheckOutcome> {
    if (chosenPath === undefined) {
      return this.classifyProbe(config, await this.probeCommand(config));
    }
    const outcome = await this.classifyProbe(config, await this.probeChosenPath(chosenPath));
    return {
      state: outcome.state,
      detail: {
        ...outcome.detail,
        chosenPath,
        ...(outcome.state === "missing" ? { message: CHOSEN_COPY_MISSING_MESSAGE } : {}),
      },
    };
  }

  private async probeChosenPath(path: string): Promise<ProbeResult> {
    try {
      await access(path, constants.X_OK);
      return { status: "found", path, via: "chosen" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (typeof code === "string" && SECURITY_ERROR_CODES.has(code)) {
        return {
          status: "blocked",
          reason: code === "EACCES" ? "permissions" : "security",
          path,
          via: "chosen",
          message: `${path} exists but execution failed with ${code} — check file permissions or security software allowlist`,
        };
      }
      return { status: "missing" };
    }
  }

  private async classifyProbe(config: AgentConfig, probe: ProbeResult): Promise<AgentCheckOutcome> {
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
      ? await this.checkAuth(config.id, config.authCheck, config.account)
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

  private async checkAuth(
    agentId: string,
    authCheck: AgentAuthCheck,
    account: AgentAccountDeclaration | undefined
  ): Promise<boolean> {
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

      if (authCheck.configHomePaths && account?.kind === "config-folder") {
        const { envVar, defaultDir } = account;
        const paths = authCheck.configHomePaths;
        const relocated = process.env[envVar];
        const isRelocated = relocated !== undefined && relocated.trim() !== "";
        // A root that isn't fully qualified resolves against the agent's
        // working directory (or drive), which differs per terminal, so nothing
        // here can confirm it.
        const root = !isRelocated
          ? join(home, defaultDir)
          : isFullyQualifiedPath(relocated)
            ? relocated
            : null;
        if (root !== null) {
          for (const relPath of paths) {
            const fullPath = join(root, relPath);
            checkedPaths.push(fullPath);
            try {
              await access(fullPath, constants.R_OK);
              return true;
            } catch {
              // File not found, continue
            }
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
   * 1. PATH, searched in-process (`findAllOnPath` on POSIX, the directory scan
   *    on Windows), capturing every resolved path. It only finds or misses.
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
   * `blocked` comes from the layers that probe a specific file (the prepended
   * CLI path, native paths, the npm-global shim) and short-circuits the rest:
   * the same endpoint security policy that blocked one copy of the binary will
   * typically block the others, so probing them would only mask the problem.
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

    const nativePaths = probedNativePaths(config);
    if (nativePaths.length > 0) {
      const nativeProbe = await this.probeNativePaths(nativePaths);
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

  /**
   * The PATH layer of the probe ladder. Every match is collected, not just the
   * first, to drive duplicate-install detection (#6054).
   *
   * POSIX walks PATH in-process: the external `which` is absent from minimal
   * Fedora and Arch installs, where spawning it reported every agent missing.
   * A file without an execute bit is skipped, as `which` skipped it, so a PATH
   * miss is always `missing` here — `blocked` comes from the layers that probe
   * a specific path (prepended, native, npm-global).
   */
  private async probeViaShell(command: string): Promise<ProbeResult> {
    if (process.platform !== "win32") {
      const allPaths = await findAllOnPath(command, {
        timeoutMs: CliAvailabilityService.WHICH_TIMEOUT_MS,
      });
      if (allPaths.length === 0) return { status: "missing" };
      return { status: "found", path: allPaths[0], via: "which", allPaths };
    }
    return this.probeWindowsPath(command);
  }

  /**
   * Every PATH match, from absolute PATH entries only, so the working directory
   * never counts. Read from the directories themselves rather than `where`,
   * whose console-code-page output mangles a non-ASCII profile path. One install
   * directory can hold several (`claude.cmd` beside `claude.exe`), which the
   * dedupe collapses, preferring the launchable wrapper. A PATH entry that does
   * not answer in time (a dropped network share) is searched past rather than
   * waited on.
   */
  private async probeWindowsPath(command: string): Promise<ProbeResult> {
    const { paths } = await scanWindowsPath(command, process.env);
    if (paths.length === 0) return { status: "missing" };
    const allPaths = dedupePathsByDirectory(paths, true);
    return { status: "found", path: allPaths[0], via: "which", allPaths };
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
        const readPrefix = async (npm: string | null): Promise<string | null> => {
          if (npm === null) return null;
          let target: Awaited<ReturnType<typeof cliSpawnTarget>>;
          try {
            target = await cliSpawnTarget(npm, ["config", "get", "prefix"], process.platform, {
              env: process.env,
            });
          } catch {
            return null;
          }
          return new Promise<string | null>((res) => {
            execFile(
              target.command,
              target.args,
              {
                timeout: CliAvailabilityService.NPM_PREFIX_TIMEOUT_MS,
                windowsHide: true,
                ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
                ...(target.env ? { env: { ...process.env, ...target.env } } : {}),
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
          });
        };
        this.npmPrefixCache = {
          checkId: this.checkId,
          // On Windows npm is `npm.cmd`, found in PATH only (asynchronously, so
          // a stalled PATH entry cannot block Main) and started by absolute path
          // (Node will not spawn a `.cmd` without a shell).
          promise:
            process.platform === "win32"
              ? findWindowsCommand("npm", process.env).then(readPrefix)
              : readPrefix("npm"),
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
        windowsSystemTool("wsl.exe"),
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
      // A variable or home set to nothing or to a relative path would leave
      // this resolving against the current drive or the working directory. A
      // bundled command starts neither way, and registration already resolved it.
      if (/^[%~]/.test(input) && !isFullyQualifiedPath(expanded)) return null;
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
   * the user confused about which copy is being launched. The toast's button
   * opens the agent's settings, which list each copy and the version it reports.
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
      if (this.notifiedDuplicateInstalls.has(milestoneKey)) continue;

      const config = configById.get(agentId);
      const agentName = config?.name ?? agentId;
      const [active, ...others] = paths;
      const PREVIEW_LIMIT = 2;
      const preview = others.slice(0, PREVIEW_LIMIT).join(", ");
      const remainder = others.length - PREVIEW_LIMIT;
      const alsoFound = remainder > 0 ? `${preview}, and ${remainder} more` : preview;
      const toast = {
        type: "warning",
        title: `Multiple ${agentName} installations found`,
        message: `Launches ${active}. Also found: ${alsoFound}.`,
        agentCliCopies: { agentId },
      };

      // The milestone records having told someone, so with nobody to tell (a window
      // showing only a remote host, a host with no view attached) a later pass tries.
      if (!hasBroadcastAudience(CHANNELS.NOTIFICATION_SHOW_TOAST, toast)) continue;

      // Claim the key before any await-free work below can broadcast it, so an
      // overlapping pass that re-read the store cannot broadcast it too.
      this.notifiedDuplicateInstalls.add(milestoneKey);

      try {
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, toast);
      } catch (err) {
        logger.error("Failed to broadcast duplicate-install toast", err, { agentId });
        // Release the claim: a broadcast that never reached the renderer should
        // still be retried on a later pass, exactly as it was before.
        this.notifiedDuplicateInstalls.delete(milestoneKey);
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
