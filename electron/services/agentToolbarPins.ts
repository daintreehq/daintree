// eager-import-allow: reads and patches this machine's toolbar pins via store.get synchronously so a check and its write share one turn
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { BUILT_IN_AGENT_IDS } from "../../shared/config/agentIds.js";
import { isAgentInstalled } from "../../shared/utils/agentAvailability.js";
import type { CliAvailability } from "../../shared/types/ipc/system.js";
import {
  isStorableAgentToolbarPinId,
  sanitizeAgentToolbarPins,
  type AgentToolbarPins,
  type AgentToolbarPinsSnapshot,
} from "../../shared/types/ipc/agentToolbarPins.js";

/** How many installed agents a fresh install pins, in registry (popularity) order. */
const INITIAL_PIN_LIMIT = 5;

let revision = 0;

/**
 * This machine's toolbar agent pins (#14702). Every window drawn on this
 * machine reads them, whichever host its project lives on; a remote Shell
 * reads its own.
 */
export function readAgentToolbarPins(): AgentToolbarPins {
  return sanitizeAgentToolbarPins(store.get("agentToolbarPins"));
}

export function readAgentToolbarPinsSnapshot(): AgentToolbarPinsSnapshot {
  return { pins: readAgentToolbarPins(), revision };
}

function commit(pins: AgentToolbarPins): AgentToolbarPinsSnapshot {
  store.set("agentToolbarPins", pins);
  revision += 1;
  const snapshot = { pins, revision };
  broadcastToRenderer(CHANNELS.AGENT_TOOLBAR_PINS_CHANGED, snapshot);
  return snapshot;
}

/**
 * Pins or unpins one agent. Patched against the stored map, never a map a view
 * sends, so a stale view can't undo another view's change to a different agent.
 */
export function setAgentToolbarPin(agentId: string, pinned: boolean): AgentToolbarPinsSnapshot {
  if (!isStorableAgentToolbarPinId(agentId)) throw new Error("Invalid agentId");
  if (typeof pinned !== "boolean") throw new Error("Invalid pinned value");
  const current = readAgentToolbarPins();
  if (current[agentId] === pinned) return readAgentToolbarPinsSnapshot();
  return commit({ ...current, [agentId]: pinned });
}

/**
 * First-run pins, once, from this machine's first complete CLI check: the
 * first few installed built-ins pinned and the rest explicitly unpinned, so the
 * toolbar and the launcher's pin state agree from the start.
 *
 * Only a fresh install lacks the key (migration 039 writes it on every upgraded
 * profile, even with no pins), and any pin written first ends the wait. The
 * check is always this machine's own, so a window driving a host never seeds
 * this machine's toolbar from the host's agents.
 */
export function seedAgentToolbarPinsIfUnset(availability: CliAvailability): boolean {
  if (store.get("agentToolbarPins") !== undefined) return false;
  const selected = new Set(
    BUILT_IN_AGENT_IDS.filter((id) => isAgentInstalled(availability[id])).slice(
      0,
      INITIAL_PIN_LIMIT
    )
  );
  commit(Object.fromEntries(BUILT_IN_AGENT_IDS.map((id) => [id, selected.has(id)])));
  return true;
}

export function _resetAgentToolbarPinsRevisionForTests(): void {
  revision = 0;
}
