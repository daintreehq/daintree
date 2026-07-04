import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfilePayload,
  type ResourceProfileSnapshot,
} from "../../../shared/types/resourceProfile.js";
import { getResourceProfileService } from "../../window/serviceRefs.js";
import type { HandlerDependencies } from "../types.js";
import { RESOURCE_PROFILE_METHOD_CHANNELS } from "./resourceProfile.preload.js";

const INTERACTIVE_OVERRIDE_DURATION_SCHEMA = z.number().finite().nonnegative().max(5_000);

export function registerResourceProfileHandlers(_deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "resourceProfile",
    ops: {
      // Pull path for late-created renderers: resource:profile-changed is a
      // push with no replay, so a view created after the last transition
      // (new window, LRU-recreated view) would otherwise run balanced
      // defaults until the next transition. Same payload shape as the push.
      getResourceProfile: op(
        RESOURCE_PROFILE_METHOD_CHANNELS.getResourceProfile,
        async (): Promise<ResourceProfilePayload> => {
          const profile = getResourceProfileService()?.getProfile() ?? "balanced";
          return { profile, config: RESOURCE_PROFILE_CONFIGS[profile] };
        }
      ),
      // Read-only host-pressure projection (profile + thermal/battery/CPU/lag
      // inputs) for diagnostics (#10500) and the MCP orchestrator (#10683).
      // Falls back to the balanced/unknown baseline when the service has not
      // started (early boot, or a renderer recreated before init).
      getResourceProfileSnapshot: op(
        RESOURCE_PROFILE_METHOD_CHANNELS.getResourceProfileSnapshot,
        async (): Promise<ResourceProfileSnapshot> => {
          return (
            getResourceProfileService()?.getSnapshot() ?? {
              profile: "balanced",
              thermalState: "unknown",
              isOnBattery: false,
              speedLimit: 100,
              lagPressureActive: false,
            }
          );
        }
      ),
      // Renderer-driven, fire-and-forget: hold the profile at ≥ balanced for a
      // short window because the user is actively interacting (scrolling a
      // full-screen mouse-reporting TUI). No-ops if the service hasn't started.
      requestInteractiveOverride: opValidated(
        RESOURCE_PROFILE_METHOD_CHANNELS.requestInteractiveOverride,
        INTERACTIVE_OVERRIDE_DURATION_SCHEMA,
        async (durationMs: number): Promise<void> => {
          getResourceProfileService()?.requestInteractiveOverride(durationMs);
        }
      ),
    },
  });

  return namespace.register();
}
