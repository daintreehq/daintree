import type { CloudMachineState } from "../../../../shared/types/cloudHosts.js";

/**
 * A Droplet's status as a machine state. DigitalOcean reports `new` while it
 * boots, `active` once it runs, `off` when powered off, and `archive` for one
 * it has set aside (a suspended account's), which can't be started from here.
 */
export function digitalOceanMachineState(status: string): CloudMachineState {
  switch (status) {
    case "new":
      return "starting";
    case "active":
      return "running";
    case "off":
      return "stopped";
    case "archive":
      return "error";
    default:
      return "unknown";
  }
}
