import { writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { E2E_TEMP_MANIFEST_ENV, E2E_TEMP_PREFIX, reapStaleTempDirs } from "./helpers/tempDirs";

/**
 * Reap temp dirs a crashed or killed run left behind, then open this run's
 * manifest. The env var is set here, in the runner, before any worker starts,
 * so every worker inherits it.
 */
export default function globalSetup(): void {
  const reaped = reapStaleTempDirs();
  if (reaped.length > 0) {
    console.log(`[e2e] reaped ${reaped.length} stale ${E2E_TEMP_PREFIX}* dirs from tmpdir`);
  }
  const runId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const manifest = path.join(tmpdir(), `${E2E_TEMP_PREFIX}manifest-${runId}.txt`);
  writeFileSync(manifest, "");
  process.env[E2E_TEMP_MANIFEST_ENV] = manifest;
}
