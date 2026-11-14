import { cloudMachineLabel, type CloudHostStatus } from "@shared/types/cloudHosts";

/** "4 vCPU · 8 GB", or what is known of it. */
export function machineSpecLabel(vcpu: number | null, memoryGB: number | null): string {
  const parts = [
    vcpu !== null ? `${vcpu} vCPU` : null,
    memoryGB !== null ? `${memoryGB} GB` : null,
  ];
  const known = parts.filter((part): part is string => part !== null);
  return known.length > 0 ? known.join(" · ") : "Size unknown";
}

/** "$0.036 an hour while running", from the account's own rate when it was read. */
export function formatHourly(dollars: number | null): string {
  if (dollars === null) return "Price not reported";
  return `$${dollars.toFixed(3)} an hour while running`;
}

export function lifetimeLabel(hours: number | null): string {
  if (hours === null) return "Never";
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * What a cloud host's machine is doing, in the user's terms: what Daintree is
 * doing to it first, then the provider's state, then why it can't be used.
 */
export function cloudStatusLabel(status: CloudHostStatus): string {
  if (status.operation) {
    switch (status.operation.kind) {
      case "creating":
        return "Creating machine";
      case "starting":
        return "Starting machine";
      case "stopping":
        return status.stop?.status === "failing" ? "Stop retrying the save" : "Stopping machine";
      case "deleting":
        return "Deleting machine";
    }
  }
  if (status.dataExpired) return "Machine data expired";
  if (status.machine === "not-created") {
    return status.lastError ? "Setup incomplete" : "Not created";
  }
  return `Machine ${cloudMachineLabel(status.machine).toLowerCase()}`;
}

/** The machine can be started by a person now. */
export function canStartMachine(status: CloudHostStatus): boolean {
  return (
    status.operation === null &&
    status.resourceId !== null &&
    !status.dataExpired &&
    (status.machine === "stopped" || status.machine === "error" || status.machine === "unknown")
  );
}

/** The machine can be stopped by a person now. */
export function canStopMachine(status: CloudHostStatus): boolean {
  return (
    status.resourceId !== null &&
    (status.operation === null || status.operation.kind === "starting") &&
    (status.machine === "running" || status.machine === "starting")
  );
}
