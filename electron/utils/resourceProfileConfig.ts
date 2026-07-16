import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfile,
  type ResourceProfileConfig,
} from "../../shared/types/resourceProfile.js";
import { getMaxWebGLContextCeiling, resolveWebglThresholds } from "./webglContextBudget.js";

/**
 * Assemble the full ResourceProfileConfig that is broadcast (on transition) and
 * pulled (by late-created renderers) to drive per-profile settings.
 *
 * RESOURCE_PROFILE_CONFIGS holds only the host-independent knobs; the
 * RAM-dependent WebGL flip thresholds are resolved here so the push path
 * (ResourceProfileService.applyProfile) and the pull path (the
 * getResourceProfile IPC handler) share one derivation and can never diverge
 * (#11192). Callers on the main process must build the renderer payload through
 * this function rather than reading the static table directly.
 */
export function resolveResourceProfileConfig(
  profile: ResourceProfile,
  ceiling: number = getMaxWebGLContextCeiling()
): ResourceProfileConfig {
  return {
    ...RESOURCE_PROFILE_CONFIGS[profile],
    ...resolveWebglThresholds(profile, ceiling),
  };
}
