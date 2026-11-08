import type { PrerequisiteCheckResult } from "@shared/types";
import { systemClient } from "@/clients";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";

function isUsable(result: PrerequisiteCheckResult): boolean {
  return result.available && result.meetsMinVersion;
}

/**
 * Publishes the fatal prerequisites a probe found missing. A live one-click
 * install keeps its state: it can start while the probe is in flight, so the
 * job is read on the way out.
 */
function publishMissing(results: PrerequisiteCheckResult[]): PrerequisiteCheckResult[] {
  const stillMissing = results.filter((p) => p.severity === "fatal" && !isUsable(p));
  const store = useMissingPrerequisiteStore.getState();
  store.setMissing(stillMissing);
  if (useMissingPrerequisiteStore.getState().install?.status !== "running") store.setInstall(null);
  return stillMissing;
}

/**
 * Probes the fatal prerequisites afresh and publishes what is still missing.
 * Forced, because the fatal check is cached and the point is to see a tool
 * that was installed since.
 */
export async function recheckMissingPrerequisites(): Promise<PrerequisiteCheckResult[]> {
  const health = await systemClient.healthCheck({ fatalOnly: true, force: true });
  return publishMissing(health.prerequisites);
}

/**
 * Whether one prerequisite is usable now, fatal or not (Node.js and the GitHub
 * CLI are only advised), from a full probe, which main never caches. The fatal
 * results it carries are published like any re-check's.
 */
export async function recheckPrerequisite(tool: string): Promise<boolean> {
  const health = await systemClient.healthCheck({ force: true });
  publishMissing(health.prerequisites);
  const result = health.prerequisites.find((p) => p.tool === tool);
  return result !== undefined && isUsable(result);
}
