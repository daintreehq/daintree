import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfile,
} from "../../../shared/types/resourceProfile.js";
import { setLogLevelOverrides } from "../../utils/logger.js";
import { setPortBatchThroughputDelayMs } from "../portBatcher.js";
import { setPluginAgentRegistry } from "../../../shared/config/pluginAgentRegistry.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createResourceConfigHandlers(ctx: HostContext): HandlerMap {
  const { processTreeCache, terminalResourceMonitor } = ctx;

  return {
    "set-resource-monitoring": (msg) => {
      terminalResourceMonitor.setEnabled(msg.enabled === true);
    },

    "set-resource-profile": (msg) => {
      const profile = msg.profile as ResourceProfile;
      const profileConfig = RESOURCE_PROFILE_CONFIGS[profile];
      if (profileConfig) {
        processTreeCache.setPollInterval(profileConfig.processTreePollInterval);
        setPortBatchThroughputDelayMs(profileConfig.portBatchThroughputDelayMs);
        console.log(
          `[PtyHost] Resource profile set to: ${msg.profile} (processTree poll: ${profileConfig.processTreePollInterval}ms, port batch: ${profileConfig.portBatchThroughputDelayMs}ms)`
        );
      }
      ctx.resourceGovernor.setResourceProfile(profile);
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

    // Mirror main's plugin-agent registry so `getEffectiveAgentConfig` resolves
    // plugin detection patterns in this process (the one running the activity
    // monitor). Main is authoritative; the pty-host only ever mirrors (#10587).
    // Guard the shape at the process boundary: only a plain object is a valid
    // registry — an array (or null) would corrupt the snapshot's spread.
    "set-plugin-agent-registry": (msg) => {
      const registry =
        msg.registry != null && typeof msg.registry === "object" && !Array.isArray(msg.registry)
          ? msg.registry
          : {};
      setPluginAgentRegistry(registry);
      // Analysis workers resolve detection patterns on their own thread —
      // mirror the registry there too (new workers receive it at spawn).
      ctx.analysisWorkerPool?.setPluginAgentRegistry(registry);
    },
  };
}
