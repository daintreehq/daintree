import { terminalClient } from "@/clients";
import { isHostSwitchPending } from "./inputGate";

export type FleetInputBroadcastHandler = (originId: string, data: string) => boolean;

let fleetInputBroadcastHandler: FleetInputBroadcastHandler | null = null;

export function registerFleetInputBroadcastHandler(
  handler: FleetInputBroadcastHandler
): () => void {
  fleetInputBroadcastHandler = handler;
  return () => {
    if (fleetInputBroadcastHandler === handler) {
      fleetInputBroadcastHandler = null;
    }
  };
}

export function resetFleetInputBroadcastHandlerForTests(): void {
  fleetInputBroadcastHandler = null;
}

export function writeTerminalInputOrFleet(originId: string, data: string): void {
  if (data.length === 0) return;
  // Not to the fleet either: what was typed for this window goes nowhere until it lands.
  if (isHostSwitchPending()) return;

  if (fleetInputBroadcastHandler?.(originId, data)) {
    return;
  }

  terminalClient.write(originId, data);
}
