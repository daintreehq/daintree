import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfile,
} from "../../../shared/types/resourceProfile.js";
import { setLogLevelOverrides } from "../../utils/logger.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createResourceConfigHandlers(ctx: HostContext): HandlerMap {
  const { processTreeCache, terminalResourceMonitor } = ctx;

  return {
    "set-resource-monitoring": (msg) => {
      terminalResourceMonitor.setEnabled(msg.enabled === true);
    },

    "set-resource-profile": (msg) => {
      const profileConfig = RESOURCE_PROFILE_CONFIGS[msg.profile as ResourceProfile];
      if (profileConfig) {
        processTreeCache.setPollInterval(profileConfig.processTreePollInterval);
        console.log(
          `[PtyHost] Resource profile set to: ${msg.profile} (processTree poll: ${profileConfig.processTreePollInterval}ms)`
        );
      }
    },

    "set-process-tree-poll-interval": (msg) => {
      if (typeof msg.ms === "number" && msg.ms > 0) {
        processTreeCache.setPollInterval(msg.ms);
      }
    },

    "set-log-level-overrides": (msg) => {
      const overrides = (msg.overrides ?? {}) as Record<string, unknown>;
      const sanitized: Record<string, string> = {};
      for (const [key, value] of Object.entries(overrides)) {
        if (typeof key === "string" && typeof value === "string") {
          sanitized[key] = value;
        }
      }
      setLogLevelOverrides(sanitized);
    },
  };
}
