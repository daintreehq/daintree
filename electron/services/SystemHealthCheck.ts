import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as semver from "semver";
import { getEffectiveAgentConfig } from "../../shared/config/agentRegistry.js";
import { refreshPath } from "../setup/environment.js";
import { BASELINE_PREREQUISITES } from "./baselinePrerequisites.js";
import type {
  PrerequisiteSpec,
  PrerequisiteSeverity,
  PrerequisiteCheckResult,
  PrerequisiteUnavailableReason,
  SystemHealthCheckOptions,
  SystemHealthCheckResult,
} from "../../shared/types/ipc.js";

const execFileAsync = promisify(execFile);

const CHECK_TIMEOUT_MS = 5_000;

const SEVERITY_RANK: Record<PrerequisiteSeverity, number> = {
  fatal: 2,
  warn: 1,
  silent: 0,
};

export { BASELINE_PREREQUISITES };

export function resolvePrerequisites(agentIds?: string[]): PrerequisiteSpec[] {
  const specMap = new Map<string, PrerequisiteSpec>();

  for (const spec of BASELINE_PREREQUISITES) {
    specMap.set(spec.tool, spec);
  }

  if (agentIds) {
    for (const agentId of agentIds) {
      const config = getEffectiveAgentConfig(agentId);
      if (!config?.prerequisites) continue;

      for (const spec of config.prerequisites) {
        const existing = specMap.get(spec.tool);
        if (!existing) {
          specMap.set(spec.tool, spec);
        } else {
          const merged = { ...existing };
          if (SEVERITY_RANK[spec.severity] > SEVERITY_RANK[existing.severity]) {
            merged.severity = spec.severity;
          }
          if (spec.minVersion && existing.minVersion) {
            const specCoerced = semver.coerce(spec.minVersion);
            const existCoerced = semver.coerce(existing.minVersion);
            if (specCoerced && existCoerced && semver.gt(specCoerced, existCoerced)) {
              merged.minVersion = spec.minVersion;
            }
          } else if (spec.minVersion && !existing.minVersion) {
            merged.minVersion = spec.minVersion;
          }
          if (spec.installUrl && !existing.installUrl) {
            merged.installUrl = spec.installUrl;
          }
          if (spec.installBlocks && !existing.installBlocks) {
            merged.installBlocks = spec.installBlocks;
          }
          if (spec.label && !existing.label) {
            merged.label = spec.label;
          }
          specMap.set(spec.tool, merged);
        }
      }
    }
  }

  return Array.from(specMap.values());
}

function extractVersion(output: string): string | null {
  const firstLine = output.split("\n")[0] ?? "";
  const coerced = semver.coerce(firstLine);
  return coerced?.version ?? null;
}

function unavailable(
  spec: PrerequisiteSpec,
  reason: PrerequisiteUnavailableReason
): PrerequisiteCheckResult {
  return {
    tool: spec.tool,
    label: spec.label,
    available: false,
    unavailableReason: reason,
    version: null,
    severity: spec.severity,
    meetsMinVersion: false,
    minVersion: spec.minVersion,
    installUrl: spec.installUrl,
    installBlocks: spec.installBlocks,
  };
}

/**
 * Whether the PATH lookup landed on the macOS Command Line Tools shim rather
 * than a real install. `/usr/bin/git` ships with the OS and exists even when
 * the tools are absent; a Homebrew git at `/opt/homebrew/bin/git` is a real
 * binary that works regardless, so it must not be gated behind the CLT probe.
 */
function isMacosCommandLineToolShim(resolvedPath: string, command: string): boolean {
  const firstMatch = resolvedPath.split("\n")[0]?.trim();
  if (!firstMatch) return false;
  return firstMatch === path.join("/usr/bin", command);
}

async function hasXcodeCommandLineTools(): Promise<boolean> {
  try {
    // A real binary, not a shim — it exits nonzero and fast when the tools are
    // missing, and never opens the installer dialog.
    await execFileAsync("xcode-select", ["-p"], {
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether the PATH lookup landed on a Windows shell shim. */
function isWindowsShellShim(resolvedPath: string): boolean {
  return /\.(cmd|bat)$/i.test(resolvedPath.split("\n")[0]?.trim() ?? "");
}

/** A bare binary name or version flag — nothing cmd.exe treats as syntax. */
const SHELL_INERT_TOKEN = /^[A-Za-z0-9._\-/=]+$/;

/**
 * Whether a version invocation can survive being flattened into a shell line.
 * Node joins command and args with spaces and hands the result to
 * `cmd.exe /d /s /c` without escaping anything (the reason passing args
 * alongside `shell` is deprecated as DEP0190), so a `&&` or a quote in an
 * argument is cmd.exe syntax rather than an argument. `checkPrerequisite` is
 * reachable from the `system:check-tool` IPC channel with a caller-supplied
 * spec, so the tokens are treated as untrusted wherever a shell is involved.
 */
export function isShellInertInvocation(command: unknown, versionArgs: unknown): boolean {
  if (typeof command !== "string" || !Array.isArray(versionArgs)) return false;
  return [command, ...versionArgs].every(
    (token) => typeof token === "string" && SHELL_INERT_TOKEN.test(token)
  );
}

/**
 * Runs a tool's version command. On Windows the entry point for a lot of tools
 * is a `.cmd`/`.bat` shim (`npm.cmd`, and anything installed as an npm global
 * bin), which current Node refuses to spawn without a shell — it rejects with
 * EINVAL. That used to be invisible because a failed version command still
 * reported the tool as available; now that a failure means unavailable, the
 * shim has to run through a shell or every such tool reads as missing.
 *
 * The shell is used only when the resolved path is genuinely a shim — a fact
 * main established from `where`, not something a caller can assert. A tool that
 * can be spawned directly is never re-run through a shell just because it
 * exited nonzero, which would both double-execute it and start interpreting its
 * arguments as shell syntax. Because a shim leaves no argv-safe way to invoke it
 * (spawning `cmd.exe` directly still hands cmd the raw line), the tokens are
 * checked instead: an invocation that isn't inert never reaches the shell, and
 * the caller sees the same unavailable result as any other failed probe.
 */
async function runVersionCommand(
  command: string,
  versionArgs: string[],
  resolvedPath: string
): Promise<string> {
  const useShell = process.platform === "win32" && isWindowsShellShim(resolvedPath);
  if (useShell && !isShellInertInvocation(command, versionArgs)) {
    throw new Error(`Refusing to run "${command}" through a shell: unsafe version arguments`);
  }
  const { stdout } = await execFileAsync(command, versionArgs, {
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    ...(useShell ? { shell: true, windowsHide: true } : {}),
  });
  return stdout;
}

export async function checkPrerequisite(spec: PrerequisiteSpec): Promise<PrerequisiteCheckResult> {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  const command = spec.command ?? spec.tool;

  let resolvedPath: string;
  try {
    const { stdout } = await execFileAsync(checkCmd, [command], {
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
    });
    resolvedPath = stdout;
  } catch {
    return unavailable(spec, "not-found");
  }

  // Never execute the CLT shim blind: without the tools installed it pops the
  // system installer dialog and hangs until the timeout kills the child, which
  // a background startup probe must not do to the user.
  if (
    process.platform === "darwin" &&
    spec.macosCommandLineTool &&
    isMacosCommandLineToolShim(resolvedPath, command) &&
    !(await hasXcodeCommandLineTools())
  ) {
    return unavailable(spec, "macos-command-line-tools-missing");
  }

  let stdout: string;
  try {
    stdout = await runVersionCommand(command, spec.versionArgs, resolvedPath);
  } catch {
    return unavailable(spec, "version-command-failed");
  }
  // Parsing is deliberately outside the try: a tool that ran fine but printed
  // an unrecognisable version string is still usable, so an unparseable version
  // leaves `available` true with `version: null`. Only a failure to *execute*
  // means unavailable.
  const version = extractVersion(stdout);

  let meetsMinVersion = true;
  if (spec.minVersion && version) {
    const coerced = semver.coerce(version);
    const minCoerced = semver.coerce(spec.minVersion);
    if (coerced && minCoerced) {
      meetsMinVersion = semver.gte(coerced, minCoerced);
    }
  } else if (spec.minVersion && !version) {
    meetsMinVersion = false;
  }

  return {
    tool: spec.tool,
    label: spec.label,
    available: true,
    version,
    severity: spec.severity,
    meetsMinVersion,
    minVersion: spec.minVersion,
    installUrl: spec.installUrl,
    installBlocks: spec.installBlocks,
  };
}

export async function getHealthCheckSpecs(agentIds?: string[]): Promise<PrerequisiteSpec[]> {
  await refreshPath();
  return resolvePrerequisites(agentIds);
}

// Cache for the fatal-only baseline check — the startup path. Every project
// view renders its own AppLayout and asks for this, so without a main-side
// cache the probe spawns once per open project. Deliberately not persisted:
// process restart is the invalidation boundary, so a prerequisite the user
// still hasn't installed comes back on the next launch.
let fatalResultCache: SystemHealthCheckResult | null = null;
let fatalInflight: Promise<SystemHealthCheckResult> | null = null;
// A forced probe that has to start only once the running one finishes. Without
// this, a re-check fired the instant an install completes could join a probe
// that began *before* it and conclude the tool is still missing.
let fatalQueuedRefresh: Promise<SystemHealthCheckResult> | null = null;
// Bumped on reset so a probe still in flight from a previous test can't land
// its result in the cache afterwards.
let fatalGeneration = 0;

/** Test seam — drops the cached fatal-only result and any in-flight probe. */
export function resetSystemHealthCheckCache(): void {
  fatalGeneration += 1;
  fatalResultCache = null;
  fatalInflight = null;
  fatalQueuedRefresh = null;
}

function startFatalProbe(): Promise<SystemHealthCheckResult> {
  const generation = fatalGeneration;
  const probe = runHealthCheck(undefined, true)
    .then((result) => {
      if (generation === fatalGeneration) fatalResultCache = result;
      return result;
    })
    .finally(() => {
      if (fatalInflight === probe) fatalInflight = null;
    });
  fatalInflight = probe;
  return probe;
}

async function runHealthCheck(agentIds?: string[], fatalOnly?: boolean) {
  await refreshPath();
  const resolved = resolvePrerequisites(agentIds);
  const specs = fatalOnly ? resolved.filter((s) => s.severity === "fatal") : resolved;

  const prerequisites = await Promise.all(specs.map((spec) => checkPrerequisite(spec)));

  const allRequired = prerequisites
    .filter((r) => r.severity === "fatal")
    .every((r) => r.available && r.meetsMinVersion);

  return { prerequisites, allRequired };
}

export async function runSystemHealthCheck(
  options?: SystemHealthCheckOptions
): Promise<SystemHealthCheckResult> {
  const { agentIds, fatalOnly, force } = options ?? {};

  // Only the agent-less fatal subset is cacheable — it's the one every view
  // requests. Agent-scoped and full checks (Settings, the Setup wizard) stay
  // fresh so a manual re-check always re-probes.
  const cacheable = fatalOnly === true && agentIds === undefined;
  if (!cacheable) return runHealthCheck(agentIds, fatalOnly);

  if (force) {
    // Nothing running — probe now.
    if (!fatalInflight) return startFatalProbe();
    // Something is running that may predate this request, so chain a fresh
    // probe behind it. Concurrent forced callers (several views regaining focus
    // together) all join that one queued probe rather than each spawning.
    if (!fatalQueuedRefresh) {
      const generation = fatalGeneration;
      const queued = fatalInflight
        .catch(() => undefined)
        .then(() => {
          // Released the moment this probe starts, not when it finishes: from
          // here on it is "already running", so a force arriving later must
          // queue its own rather than join one that predates it.
          if (fatalQueuedRefresh === queued) fatalQueuedRefresh = null;
          // A reset landed while this was waiting — run detached so it can't
          // publish into the new generation's cache or displace its probe.
          if (generation !== fatalGeneration) return runHealthCheck(undefined, true);
          return startFatalProbe();
        });
      fatalQueuedRefresh = queued;
    }
    return fatalQueuedRefresh;
  }

  if (fatalResultCache) return fatalResultCache;
  return fatalInflight ?? startFatalProbe();
}
