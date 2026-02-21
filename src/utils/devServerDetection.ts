import type { RunCommand } from "@shared/types";

const DEV_SCRIPT_PRIORITY = ["dev", "start", "serve"];

/**
 * Find the best dev server candidate from detected runners
 * Priority: dev > start > serve
 */
export function findDevServerCandidate(
  allDetectedRunners: RunCommand[] | undefined
): RunCommand | undefined {
  if (!allDetectedRunners) {
    return undefined;
  }

  return DEV_SCRIPT_PRIORITY.map((name) =>
    allDetectedRunners.find((runner) => runner.name === name)
  ).find((runner) => runner !== undefined);
}
