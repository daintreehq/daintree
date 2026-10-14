import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { AGENT_DEFAULTS_METHOD_CHANNELS } from "./agentDefaults.preload.js";
import {
  migrateLegacyAgentDefaults,
  readAgentDefaults,
  setAgentDefaults,
} from "../../services/agentDefaults.js";
import type {
  AgentDefaultsLegacyCandidates,
  AgentDefaultsPatch,
  AgentDefaultsSnapshot,
} from "../../../shared/types/ipc/agentDefaults.js";

/**
 * A window attached to this host from another machine reads that machine's
 * localStorage, so its legacy values describe the Shell, never this host. The
 * renderer already skips the call there; this keeps a host from being seeded
 * by one that didn't.
 */
function fromRemoteView(ctx: IpcContext): boolean {
  return ctx.endpoint?.kind === "remote-view" || ctx.client?.kind !== "local";
}

export const agentDefaultsNamespace = defineIpcNamespace({
  name: "agentDefaults",
  ops: {
    get: op(AGENT_DEFAULTS_METHOD_CHANNELS.get, async (): Promise<AgentDefaultsSnapshot> => {
      return readAgentDefaults();
    }),
    set: op(
      AGENT_DEFAULTS_METHOD_CHANNELS.set,
      async (patch: AgentDefaultsPatch): Promise<AgentDefaultsSnapshot> => {
        setAgentDefaults(patch);
        return readAgentDefaults();
      }
    ),
    migrateLegacy: op(
      AGENT_DEFAULTS_METHOD_CHANNELS.migrateLegacy,
      async (
        ctx: IpcContext,
        candidates: AgentDefaultsLegacyCandidates
      ): Promise<AgentDefaultsSnapshot> => {
        if (fromRemoteView(ctx)) return readAgentDefaults();
        return migrateLegacyAgentDefaults(candidates);
      },
      { withContext: true }
    ),
  },
});

export function registerAgentDefaultsHandlers(): () => void {
  return agentDefaultsNamespace.register();
}
