import { execFileSync } from "child_process";
import * as semver from "semver";
import { getEffectiveAgentConfig } from "../../shared/config/agentRegistry.js";
import type {
  PrerequisiteSpec,
  PrerequisiteSeverity,
  PrerequisiteCheckResult,
  SystemHealthCheckResult,
} from "../../shared/types/ipc.js";

const CHECK_TIMEOUT_MS = 5_000;

const SEVERITY_RANK: Record<PrerequisiteSeverity, number> = {
  fatal: 2,
  warn: 1,
  silent: 0,
};

export const BASELINE_PREREQUISITES: PrerequisiteSpec[] = [
  {
    tool: "git",
    label: "Git",
    versionArgs: ["--version"],
    severity: "fatal",
    installUrl: "https://git-scm.com/downloads",
  },
  {
    tool: "node",
    label: "Node.js",
    versionArgs: ["--version"],
    severity: "fatal",
    minVersion: "18.0.0",
    installUrl: "https://nodejs.org",
  },
  {
    tool: "npm",
    label: "npm",
    versionArgs: ["--version"],
    severity: "warn",
    installUrl: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
  },
  {
    tool: "gh",
    label: "GitHub CLI",
    versionArgs: ["--version"],
    severity: "warn",
    installUrl: "https://cli.github.com",
  },
];

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

function checkPrerequisite(spec: PrerequisiteSpec): PrerequisiteCheckResult {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  const command = spec.command ?? spec.tool;

  try {
    execFileSync(checkCmd, [command], { stdio: "ignore", timeout: CHECK_TIMEOUT_MS });
  } catch {
    return {
      tool: spec.tool,
      label: spec.label,
      available: false,
      version: null,
      severity: spec.severity,
      meetsMinVersion: false,
      minVersion: spec.minVersion,
      installUrl: spec.installUrl,
    };
  }

  let version: string | null = null;
  try {
    const output = execFileSync(command, spec.versionArgs, {
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    version = extractVersion(output);
  } catch {
    // Tool exists but version extraction failed
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
  };
}

export async function runSystemHealthCheck(agentIds?: string[]): Promise<SystemHealthCheckResult> {
  const specs = resolvePrerequisites(agentIds);

  const results = await Promise.all(
    specs.map(
      (spec) =>
        new Promise<PrerequisiteCheckResult>((resolve) => {
          setImmediate(() => resolve(checkPrerequisite(spec)));
        })
    )
  );

  const allRequired = results
    .filter((r) => r.severity === "fatal")
    .every((r) => r.available && r.meetsMinVersion);

  return { prerequisites: results, allRequired };
}
