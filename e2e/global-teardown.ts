import {
  E2E_KEEP_USERDATA_ENV,
  E2E_TEMP_MANIFEST_ENV,
  removeRecordedTempDirs,
  removeTempPath,
} from "./helpers/tempDirs";

/**
 * Remove every userData and HOME dir this run's launches created. Deliberately
 * not in `closeApp`: restart journeys relaunch on the same userData after
 * closing. `DAINTREE_E2E_KEEP_USERDATA=1` keeps them for a post-mortem.
 */
export default function globalTeardown(): void {
  const manifest = process.env[E2E_TEMP_MANIFEST_ENV];
  if (!manifest) return;
  if (process.env[E2E_KEEP_USERDATA_ENV] === "1") {
    console.log(`[e2e] keeping temp dirs; list in ${manifest}`);
    return;
  }
  const { skipped } = removeRecordedTempDirs(manifest);
  if (skipped.length > 0) {
    console.warn(`[e2e] could not remove ${skipped.length} temp dirs: ${skipped.join(", ")}`);
  }
  removeTempPath(manifest);
}
