import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfile,
} from "../../../shared/types/resourceProfile.js";
import { setLogLevelOverrides } from "../../utils/logger.js";
import { setPortBatchThroughputDelayMs } from "../portBatcher.js";
import { setPluginAgentRegistry } from "../../../shared/config/pluginAgentRegistry.js";
import { setPluginProcessToolRegistry } from "../../../shared/config/pluginProcessToolRegistry.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createResourceConfigHandlers(ctx: HostContext): HandlerMap {
  const { processTreeCache, terminalResourceMonitor } = ctx;
  let lastProfile: ResourceProfile | null = null;

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

      // One-shot analysis-session trim on ENTRY into efficiency (not on every
      // profile push — main replays the profile on host-ready and transitions
      // can flap). The per-session policy protects active agents and recently
      // used terminals; the resource governor's own heap-driven trims remain
      // the backstop for genuine in-host pressure regardless of profile.
      const entering = profile === "efficiency" && lastProfile !== "efficiency";
      lastProfile = profile;
      if (entering) {
        try {
          const { trimmed, skipped } = ctx.ptyManager.trimIdleAnalysisSessions();
          if (trimmed > 0) {
            console.log(
              `[PtyHost] Efficiency entry trimmed ${trimmed} idle analysis session(s) (${skipped} protected)`
            );
          }
        } catch (err) {
          console.warn("[PtyHost] Idle analysis-session trim failed:", err);
        }
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

    // Mirror main's plugin process-tool registry so `getProcessIconMap` resolves
    // plugin-contributed command → icon detections in this process (the one
    // running `ProcessDetector`). Main is authoritative; the pty-host only ever
    // mirrors (#11613). Same boundary guard as the agent registry above — only a
    // plain object is a valid registry. Analysis workers are deliberately NOT
    // mirrored: they resolve agent activity patterns and never consult the
    // process-icon map.
    "set-plugin-process-tool-registry": (msg) => {
      const registry =
        msg.registry != null && typeof msg.registry === "object" && !Array.isArray(msg.registry)
          ? msg.registry
          : {};
      setPluginProcessToolRegistry(registry);
    },
  };
}
