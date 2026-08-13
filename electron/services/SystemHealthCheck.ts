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

export async function checkPrerequisite(spec: PrerequisiteSpec): Promise<PrerequisiteCheckResult> {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  const command = spec.command ?? spec.tool;

  let resolvedPath = "";
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

  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(command, spec.versionArgs, {
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
    });
    // Parsing is deliberately outside the try: a tool that ran fine but printed
    // an unrecognisable version string is still usable, so an unparseable
    // version leaves `available` true with `version: null`. Only a failure to
    // *execute* means unavailable.
    version = extractVersion(stdout);
  } catch {
    return unavailable(spec, "version-command-failed");
  }

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

/** Test seam — drops the cached fatal-only result and any in-flight probe. */
export function resetSystemHealthCheckCache(): void {
  fatalResultCache = null;
  fatalInflight = null;
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

  if (!force && fatalResultCache) return fatalResultCache;
  // A forced run bypasses the settled cache but still joins an in-flight probe,
  // so N views regaining focus together produce one spawn, not N.
  if (fatalInflight) return fatalInflight;

  const inflight = runHealthCheck(agentIds, fatalOnly)
    .then((result) => {
      fatalResultCache = result;
      return result;
    })
    .finally(() => {
      if (fatalInflight === inflight) fatalInflight = null;
    });
  fatalInflight = inflight;
  return inflight;
}
