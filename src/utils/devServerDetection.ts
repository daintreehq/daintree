import type { RunCommand } from "@shared/types";

const DEV_SCRIPT_PRIORITY = ["dev", "start", "serve"];

const NEXT_DEV_RE = /\bnext\s+dev\b/;
const TURBOPACK_FLAG_RE = /--turbo(?:pack)?\b/;
const SHELL_CONTROL_RE = /[;&|#]|<|>|\$\(/;

function applyNextjsTurbopack(runner: RunCommand, turbopackEnabled = true): RunCommand {
  if (!turbopackEnabled) return runner;
  const desc = runner.description ?? "";
  if (!NEXT_DEV_RE.test(desc) || TURBOPACK_FLAG_RE.test(desc) || SHELL_CONTROL_RE.test(desc)) {
    return runner;
  }
  const sep = runner.command.trimStart().startsWith("bun ") ? " " : " -- ";
  return { ...runner, command: `${runner.command}${sep}--turbopack` };
}

export function findAllDevServerCandidates(
  allDetectedRunners: RunCommand[] | undefined,
  turbopackEnabled = true
): RunCommand[] {
  if (!allDetectedRunners || allDetectedRunners.length === 0) return [];

  const seen = new Set<string>();
  const result: RunCommand[] = [];
  let hasPriorityMatch = false;

  for (const name of DEV_SCRIPT_PRIORITY) {
    const runner = allDetectedRunners.find((r) => r.name === name && !seen.has(r.id));
    if (runner) {
      seen.add(runner.id);
      result.push(applyNextjsTurbopack(runner, turbopackEnabled));
      hasPriorityMatch = true;
    }
  }

  if (!hasPriorityMatch) {
    const devcontainer = allDetectedRunners.find((r) => r.id === "devcontainer-poststart");
    if (devcontainer && !seen.has(devcontainer.id)) {
      seen.add(devcontainer.id);
      result.push(devcontainer);
    }
  }

  for (const runner of allDetectedRunners) {
    if (!seen.has(runner.id)) {
      seen.add(runner.id);
      result.push(applyNextjsTurbopack(runner, turbopackEnabled));
    }
  }

  return result;
}

export function findDevServerCandidate(
  allDetectedRunners: RunCommand[] | undefined,
  turbopackEnabled = true
): RunCommand | undefined {
  return findAllDevServerCandidates(allDetectedRunners, turbopackEnabled)[0];
}
