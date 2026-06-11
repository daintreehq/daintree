import { app } from "electron";

/**
 * True when this x64 build is being translated by Rosetta on an Apple Silicon
 * Mac. Darwin-gated because `app.runningUnderARM64Translation` also reports
 * `true` for x64 builds under WOW64 on Windows ARM, where a "download the
 * Apple Silicon build" prompt would be wrong.
 */
export function isRunningUnderRosetta(): boolean {
  return process.platform === "darwin" && app.runningUnderARM64Translation === true;
}
