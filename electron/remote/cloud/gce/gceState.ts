import type { CloudMachineState } from "../../../../shared/types/cloudHosts.js";

/**
 * A Compute Engine instance status as a machine state. `TERMINATED` is
 * Compute Engine's word for a stopped VM whose disks are kept; a `SUSPENDED`
 * one keeps its memory too, and a start resumes it.
 */
export function gceMachineState(status: string): CloudMachineState {
  switch (status) {
    case "PENDING":
    case "PROVISIONING":
    case "STAGING":
    case "REPAIRING":
      return "starting";
    case "RUNNING":
      return "running";
    case "PENDING_STOP":
    case "STOPPING":
    case "SUSPENDING":
      return "stopping";
    case "TERMINATED":
    case "STOPPED":
    case "SUSPENDED":
      return "stopped";
    default:
      return "unknown";
  }
}
