import type { CloudMachineState } from "../../../../shared/types/cloudHosts.js";

/**
 * Boat's sandbox state as a machine state. Only the machine: Boat's `idle`
 * and `running` describe its own integrated agent, never whether Daintree has
 * work there, so both read as a running machine.
 */
export function boatMachineState(state: string): CloudMachineState {
  switch (state) {
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
      return "starting";
    case "ready":
    case "idle":
    case "running":
      return "running";
    case "archiving":
      return "stopping";
    case "archived":
      return "stopped";
    case "error":
      return "error";
    case "cancelled":
      return "deleted";
    default:
      return "unknown";
  }
}

/** The machine accepts SSH: Boat says it is ready to accept the user. */
export function boatAcceptsSsh(state: string): boolean {
  return boatMachineState(state) === "running";
}

/** Boat's list price per machine hour for a size, from the account's own hourly rate and the size's multiplier. */
export const BOAT_SIZE_MULTIPLIERS: Record<string, number> = {
  small: 0.5,
  default: 1,
  large: 2,
  xlarge: 0.2 / 0.036,
};

/** Published sizes (vCPU, GB RAM) for the labels; the account's limits decide availability. */
export const BOAT_SIZE_SPECS: Record<string, { vcpu: number; memoryGB: number; label: string }> = {
  small: { vcpu: 2, memoryGB: 4, label: "Small" },
  default: { vcpu: 4, memoryGB: 8, label: "Default" },
  large: { vcpu: 8, memoryGB: 16, label: "Large" },
  xlarge: { vcpu: 16, memoryGB: 32, label: "Extra large" },
};
