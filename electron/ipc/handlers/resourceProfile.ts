import { defineIpcNamespace, op } from "../define.js";
import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfilePayload,
} from "../../../shared/types/resourceProfile.js";
import { getResourceProfileService } from "../../window/serviceRefs.js";
import type { HandlerDependencies } from "../types.js";
import { RESOURCE_PROFILE_METHOD_CHANNELS } from "./resourceProfile.preload.js";

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
    },
  });

  return namespace.register();
}
