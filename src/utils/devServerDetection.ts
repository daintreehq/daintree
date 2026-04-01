import type { RunCommand } from "@shared/types";

const DEV_SCRIPT_PRIORITY = ["dev", "start", "serve"];

const NEXT_DEV_RE = /\bnext\s+dev\b/;
const TURBOPACK_FLAG_RE = /--turbo(?:pack)?\b/;

function applyNextjsTurbopack(runner: RunCommand): RunCommand {
  const desc = runner.description ?? "";
  if (!NEXT_DEV_RE.test(desc) || TURBOPACK_FLAG_RE.test(desc)) {
    return runner;
  }
  const sep = runner.command.trimStart().startsWith("bun ") ? " " : " -- ";
  return { ...runner, command: `${runner.command}${sep}--turbopack` };
}

export function findDevServerCandidate(
  allDetectedRunners: RunCommand[] | undefined
): RunCommand | undefined {
  if (!allDetectedRunners) {
    return undefined;
  }

  const candidate = DEV_SCRIPT_PRIORITY.map((name) =>
    allDetectedRunners.find((runner) => runner.name === name)
  ).find((runner) => runner !== undefined);

  return candidate ? applyNextjsTurbopack(candidate) : undefined;
}
