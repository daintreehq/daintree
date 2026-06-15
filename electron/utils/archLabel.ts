import { isRunningUnderRosetta } from "./rosettaDetection.js";

/**
 * Human-readable label for the running build architecture, for the "About
 * Daintree" card and GitHub issue bodies. Reports the *running* slice, not the
 * package type — a Universal binary running natively on Apple Silicon is
 * indistinguishable from a single-arch arm64 build by `process.arch` alone, so
 * we deliberately surface the running arch plus Rosetta state (the support
 * signal behind #10341/#10498) rather than guessing "Universal".
 *
 * On non-macOS platforms there is no Rosetta equivalent, so the raw
 * `process.arch` value (e.g. `x64`, `arm64`) is returned. Any failure falls
 * back to the raw arch so this never throws into the IPC layer.
 */
export function buildArchLabel(): string {
  try {
    if (process.platform === "darwin") {
      if (isRunningUnderRosetta()) return "Intel (Rosetta)";
      if (process.arch === "arm64") return "Apple Silicon";
      if (process.arch === "x64") return "Intel";
    }
    return process.arch;
  } catch {
    return process.arch;
  }
}
