import type { CloudMachineState } from "../../../../shared/types/cloudHosts.js";

/**
 * A Compute Engine instance status as a machine state. `TERMINATED` is
 * Compute Engine's word for a stopped VM whose disks are kept; `SUSPENDED`
 * also keeps them but needs a resume, not a start, so it reads as an error
 * Daintree can't start from.
 */
export function gceMachineState(status: string): CloudMachineState {
  switch (status) {
    case "PROVISIONING":
    case "STAGING":
    case "REPAIRING":
      return "starting";
    case "RUNNING":
      return "running";
    case "STOPPING":
    case "SUSPENDING":
      return "stopping";
    case "TERMINATED":
    case "STOPPED":
      return "stopped";
    case "SUSPENDED":
      return "error";
    default:
      return "unknown";
  }
}
