import type { PrerequisiteCheckResult } from "@shared/types";
import { systemClient } from "@/clients";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";

/**
 * Probes the fatal prerequisites afresh and publishes what is still missing.
 * Forced, because the fatal check is cached and the point is to see a tool
 * that was installed since. A live one-click install keeps its state: it can
 * start while the probe is in flight, so the job is read on the way out.
 */
export async function recheckMissingPrerequisites(): Promise<PrerequisiteCheckResult[]> {
  const health = await systemClient.healthCheck({ fatalOnly: true, force: true });
  const stillMissing = health.prerequisites.filter((p) => !p.available || !p.meetsMinVersion);
  const store = useMissingPrerequisiteStore.getState();
  store.setMissing(stillMissing);
  if (useMissingPrerequisiteStore.getState().install?.status !== "running") store.setInstall(null);
  return stillMissing;
}
