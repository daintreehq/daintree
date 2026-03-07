import { execFileSync } from "child_process";
import type { SystemHealthCheckResult, PrerequisiteCheckResult } from "../../shared/types/ipc.js";

const CHECK_TIMEOUT_MS = 5_000;

interface PrerequisiteConfig {
  tool: string;
  command: string;
  versionArgs: string[];
  required: boolean;
}

const PREREQUISITES: PrerequisiteConfig[] = [
  { tool: "git", command: "git", versionArgs: ["--version"], required: true },
  { tool: "node", command: "node", versionArgs: ["--version"], required: true },
  { tool: "npm", command: "npm", versionArgs: ["--version"], required: false },
];

function extractVersion(output: string, tool: string): string {
  const text = output.trim();
  if (tool === "git") {
    const match = /git version (\S+)/.exec(text);
    return match ? match[1] : text;
  }
  return text.replace(/^v/, "");
}

function checkPrerequisite(config: PrerequisiteConfig): PrerequisiteCheckResult {
  const checkCmd = process.platform === "win32" ? "where" : "which";

  try {
    execFileSync(checkCmd, [config.command], { stdio: "ignore", timeout: CHECK_TIMEOUT_MS });
  } catch {
    return { tool: config.tool, available: false, version: null };
  }

  try {
    const output = execFileSync(config.command, config.versionArgs, {
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return {
      tool: config.tool,
      available: true,
      version: extractVersion(output, config.tool),
    };
  } catch {
    return { tool: config.tool, available: true, version: null };
  }
}

export async function runSystemHealthCheck(): Promise<SystemHealthCheckResult> {
  const results = await Promise.all(
    PREREQUISITES.map(
      (config) =>
        new Promise<PrerequisiteCheckResult>((resolve) => {
          setImmediate(() => resolve(checkPrerequisite(config)));
        })
    )
  );

  const required = PREREQUISITES.filter((p) => p.required).map((p) => p.tool);
  const allRequired = results.filter((r) => required.includes(r.tool)).every((r) => r.available);

  return { prerequisites: results, allRequired };
}
