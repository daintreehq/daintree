import type { HostId } from "../../../shared/types/remoteHosts.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { registerRemoteService } from "../runtime.js";
import { AssistantMessagingPolicy } from "./AssistantMessagingPolicy.js";

declare module "../runtime.js" {
  interface RemoteServices {
    assistantMessagingPolicy: AssistantMessagingPolicy;
  }
}

export interface AssistantMessagingPolicyInstallDeps {
  /** This Shell's per-host opt-in, read from the host list at each check. */
  isHostMessagingEnabled(hostId: HostId): boolean;
}

/** Registers the process's one messaging policy; the returned teardown disposes it. */
export function installAssistantMessagingPolicy(
  deps: AssistantMessagingPolicyInstallDeps
): () => void {
  const policy = new AssistantMessagingPolicy({
    getRunningLaneSession: (projectId, slot) =>
      helpSessionService.getRunningLaneSession(projectId, slot),
    getLaunchGeneration: (terminalId) => getPtyClient()?.getLaunchGeneration(terminalId) ?? null,
    isHostMessagingEnabled: deps.isHostMessagingEnabled,
    onSessionEnded: (listener) => helpSessionService.addSessionEndedListener(listener),
  });
  const unregister = registerRemoteService("assistantMessagingPolicy", policy);
  return () => {
    unregister();
    policy.dispose();
  };
}
