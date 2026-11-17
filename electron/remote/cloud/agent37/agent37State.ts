import type { CloudMachineState } from "../../../../shared/types/cloudHosts.js";

/**
 * Agent 37's instance status as a machine state. A sleeping instance reads as
 * stopped: it bills its disk alone, as a stopped one does, and Daintree never
 * wakes it on its own (a dial to it would, and an open link keeps it awake).
 * A person's Start wakes it, the same call that starts a stopped one.
 */
export function agent37MachineState(status: string): CloudMachineState {
  switch (status) {
    case "provisioning":
    case "starting":
    case "restarting":
    case "updating":
    case "waking":
      return "starting";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "stopped":
    case "sleeping":
      return "stopped";
    case "failed":
      return "error";
    case "deleting":
    case "deleted":
      return "deleted";
    default:
      return "unknown";
  }
}
