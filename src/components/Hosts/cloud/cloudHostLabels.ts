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

/** "$0.036/h", for a line that already says what is running; null when no rate was read. */
export function hourlyShort(dollars: number | null): string | null {
  return dollars === null ? null : `$${dollars.toFixed(3)}/h`;
}

export function lifetimeLabel(hours: number | null): string {
  if (hours === null) return "Never";
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** "2 hours", "30 minutes", "90 minutes": exact, since an imported machine's lifetime needn't be whole hours. */
export function durationLabel(seconds: number): string {
  if (seconds % 3600 === 0) return lifetimeLabel(seconds / 3600);
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** A provider's reason as a sentence start: providers write theirs lowercase. */
export function sentenceCase(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** "Sat 19:02" in this device's locale; null for a missing or unreadable time. */
export function clockTime(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * What the machine is doing, in one word or two: what Daintree is doing to it
 * first, then what the provider last reported. For a row already labelled
 * "Machine".
 */
export function cloudStateWord(status: CloudHostStatus): string {
  if (status.operation) {
    switch (status.operation.kind) {
      case "creating":
        return "Creating";
      case "starting":
        return "Starting";
      case "stopping":
        return status.stop?.status === "failing" ? "Stopping, retrying the save" : "Stopping";
      case "deleting":
        return "Deleting";
    }
  }
  if (status.dataExpired) return "Saved disk expired";
  // Not proof of anything: a refused key or a lost scope reads the same as a deleted machine.
  if (status.machine === "unknown") return "Couldn't check its state";
  if (status.machine === "not-created")
    return status.lastError ? "Setup incomplete" : "Not created";
  return cloudMachineLabel(status.machine);
}

/**
 * The same, naming the machine, for a line among other facts about the host.
 * A reading past its freshness says it is the last one, not the current one.
 */
export function cloudStatusLabel(status: CloudHostStatus, stale = false): string {
  const word = cloudStateWord(status);
  if (status.operation === null) {
    if (status.machine === "not-created") return word;
    if (status.machine === "unknown") return "Couldn't check the machine";
    if (stale) return `Last reported ${word.toLowerCase()}`;
  }
  return `Machine ${word.toLowerCase()}`;
}

/**
 * The toolbar chip's few words, beside a name it must never squeeze: never
 * truncated there, so the long states have short forms.
 */
export function cloudChipStatus(status: CloudHostStatus): string {
  if (status.operation === null && status.machine === "unknown") return "state unknown";
  if (status.operation?.kind === "stopping") return "machine stopping";
  return cloudStatusLabel(status).toLowerCase();
}

/** Past this, a stopped machine's reading is old: a little over two of its polls. */
const STOPPED_FRESH_MS = 12 * 60_000;
/** Everything else is polled at least every minute. */
const FRESH_MS = 3 * 60_000;

/**
 * The provider's last answer is too old to pass for the machine's state now:
 * polls have been failing, or the machine changed somewhere Daintree can't see.
 */
export function isObservationStale(status: CloudHostStatus, now: number): boolean {
  if (status.operation !== null || status.resourceId === null) return false;
  if (status.observedAt === null) return true;
  return now - status.observedAt > (status.machine === "stopped" ? STOPPED_FRESH_MS : FRESH_MS);
}

/** Worth asking the provider again from here: its state is unknown or its reading is old. */
export function canCheckMachine(status: CloudHostStatus, now: number): boolean {
  return (
    status.operation === null &&
    status.resourceId !== null &&
    (status.machine === "unknown" || isObservationStale(status, now))
  );
}

/**
 * The facts that decide what a machine costs now: its rate while it bills,
 * and when it stops by itself. A stopped machine's rate is what a start costs.
 */
export function cloudCostFacts(status: CloudHostStatus): string[] {
  const rate = hourlyShort(status.hourlyDollars);
  const running = status.machine === "running" || status.machine === "starting";
  const facts: string[] = [];
  if (running) {
    if (rate) facts.push(rate);
    const stop = clockTime(status.autoStopAt);
    if (status.machine === "running") {
      facts.push(stop ? `stops by itself ${stop}` : "no auto-stop");
    }
  } else if (rate && canStartMachine(status)) {
    facts.push(`${rate} when started`);
  }
  return facts;
}

/** The machine can be started by a person now. */
export function canStartMachine(status: CloudHostStatus): boolean {
  return (
    status.operation === null &&
    status.resourceId !== null &&
    !status.dataExpired &&
    (status.machine === "stopped" || status.machine === "error")
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

/**
 * When a machine stops by itself, in one sentence for anywhere a lifetime is
 * chosen or a start confirmed. Daintree pushes the stop back while the host
 * is in use from this device, so the lifetime is a guard, not a budget.
 */
export function lifetimeSentence(lifetimeSeconds: number | null): string {
  if (lifetimeSeconds === null) return "It runs until you stop it.";
  return `It stops by itself ${durationLabel(lifetimeSeconds)} after starting, pushed back while a window here shows it or its agents are working.`;
}
