import { defineIpcNamespace, op } from "../define.js";
import { AGENT_TOOLBAR_PINS_METHOD_CHANNELS } from "./agentToolbarPins.preload.js";
import {
  readAgentToolbarPinsSnapshot,
  setAgentToolbarPin,
} from "../../services/agentToolbarPins.js";
import type { AgentToolbarPinsSnapshot } from "../../../shared/types/ipc/agentToolbarPins.js";

export const agentToolbarPinsNamespace = defineIpcNamespace({
  name: "agentToolbarPins",
  ops: {
    get: op(
      AGENT_TOOLBAR_PINS_METHOD_CHANNELS.get,
      async (): Promise<AgentToolbarPinsSnapshot> => readAgentToolbarPinsSnapshot()
    ),
    set: op(
      AGENT_TOOLBAR_PINS_METHOD_CHANNELS.set,
      async (agentId: string, pinned: boolean): Promise<AgentToolbarPinsSnapshot> =>
        setAgentToolbarPin(agentId, pinned)
    ),
  },
});

export function registerAgentToolbarPinsHandlers(): () => void {
  return agentToolbarPinsNamespace.register();
}
