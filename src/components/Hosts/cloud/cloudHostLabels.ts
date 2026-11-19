import { pluralize } from "@/lib/pluralize";
import {
  cloudMachineLabel,
  type CloudHostStatus,
  type CloudLifetimeModel,
  type CloudLinkedIdleStop,
  type CloudProviderInfo,
  type CloudProviderPersistence,
} from "@shared/types/cloudHosts";
import type { HostIdleObservation } from "@shared/types/hostIdle";

/** The parts of a provider's declaration that decide what stopping and deleting mean. */
export type CloudProviderTerms = Pick<CloudProviderInfo, "name" | "capabilities" | "hostIdleStop">;

/** The provider a host's machine runs on, or null while it isn't registered. */
export function cloudProviderFor<P extends { id: string }>(
  providers: readonly P[],
  status: Pick<CloudHostStatus, "providerId"> | null
): P | null {
  if (!status) return null;
  return providers.find((provider) => provider.id === status.providerId) ?? null;
}

/**
 * What a provider is called: the registered one's own name, else what its
 * plugin's provider was last known as (#17353), else its id.
 */
export function cloudProviderName(
  provider: Pick<CloudProviderInfo, "name"> | null,
  subject: Pick<CloudHostStatus, "providerId" | "pluginProvider">
): string {
  return provider?.name ?? subject.pluginProvider?.providerName ?? subject.providerId;
}

/** Whether a stopped machine on this provider still bills for compute; false when it isn't known. */
export function billsWhileStopped(provider: CloudProviderTerms | null): boolean {
  return provider?.capabilities.persistence.stoppedComputeBilled === true;
}

/**
 * Daintree removes machines from a provider only when its declaration says it
 * can. An unregistered provider keeps today's choice: a delete through it is
 * refused with the reason it's unavailable.
 */
export function canDeleteMachines(provider: CloudProviderTerms | null): boolean {
  return provider === null || provider.capabilities.deletion;
}

/**
 * For a provider that bills a stopped machine, that it does and the way to
 * stop paying: Delete when Daintree can, the provider's console otherwise.
 * For one that bills a stopped machine's disk alone, that it does, asleep
 * too where its machines sleep. Null for one where stopping ends billing.
 */
export function stoppedBillingSentence(provider: CloudProviderTerms | null): string | null {
  if (!provider) return null;
  if (billsWhileStopped(provider)) {
    const stopPaying = provider.capabilities.deletion
      ? "remove the host and delete its machine"
      : `delete the machine in ${provider.name}'s console`;
    return `${stoppedComputeBilling(provider)} To stop paying for it, ${stopPaying}.`;
  }
  if (!provider.capabilities.persistence.stoppedStorageBilled) return null;
  const parked =
    provider.capabilities.lifetime.kind === "idle-sleep" ? "stopped or asleep" : "stopped";
  return `${provider.name} bills only for its disk while it's ${parked}.`;
}

/** That a stopped machine keeps billing for compute, in the provider's own words where it gave them. */
function stoppedComputeBilling(provider: CloudProviderTerms): string {
  return (
    provider.capabilities.persistence.stoppedBilling ??
    `${provider.name} keeps billing a stopped machine for compute until it's deleted.`
  );
}

/** That a stopped machine on this provider is still billing, for a line of short facts. */
export function stoppedBillingFact(
  status: Pick<CloudHostStatus, "machine">,
  provider: CloudProviderTerms | null
): string | null {
  return status.machine === "stopped" && billsWhileStopped(provider) ? "still billing" : null;
}

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
  return pluralize(hours, "hour");
}

/** "2 hours", "30 minutes", "90 minutes": exact, since an imported machine's lifetime needn't be whole hours. */
export function durationLabel(seconds: number): string {
  if (seconds % 3600 === 0) return lifetimeLabel(seconds / 3600);
  if (seconds % 60 !== 0) return pluralize(seconds, "second");
  const minutes = Math.round(seconds / 60);
  return pluralize(minutes, "minute");
}

/** What stopping keeps and loses, as the provider describes it, for a Stop confirm. */
export function stopKeepsSentence(persistence: CloudProviderPersistence): string {
  // A finite retention says so where the stop is decided, not only on the details page.
  const kept =
    persistence.retentionDays !== null
      ? `kept for at least ${persistence.retentionDays} days while it's stopped, and may be deleted after that`
      : "kept for when you start it again";
  return `${persistence.kept} are ${kept}; ${persistence.lost} aren't.`;
}

/** The same promise for a stopped machine's disk, with how long the provider keeps it. */
export function diskSentence(persistence: CloudProviderPersistence): string {
  const kept =
    persistence.retentionDays !== null
      ? ` and kept at least ${persistence.retentionDays} days while it's stopped`
      : "";
  return `${persistence.kept} are saved when it stops${kept}; ${persistence.lost} aren't.`;
}

/** A provider's reason as a sentence start: providers write theirs lowercase. */
/**
 * What a provider's credentials are called in buttons and copy: a key when it
 * asks for one value, credentials when it asks for several or isn't registered.
 */
export function credentialsNoun(
  provider: CloudProviderInfo | null | undefined
): "key" | "credentials" {
  return provider?.credentialFields.length === 1 ? "key" : "credentials";
}

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

/** What the host's idle time counts from, and where it is kept. */
export const IDLE_TIME_COUNTED =
  "Counted on the host from the last time an agent there was working or waiting, or a window showed it, so it runs with this device away";

/**
 * What a host's idle clock shows: in use, or idle since when and when its
 * idle time ends. Both times are the host's own; `sampledAt` is when it last
 * looked, so whether that time has passed is the host's call, not this
 * machine's clock.
 */
export function idleClockSentence(
  idle: HostIdleObservation | undefined,
  sampledAt: number | null
): string {
  if (!idle) return IDLE_TIME_COUNTED;
  if (idle.busy || idle.idleEndsAt === null) {
    return idle.stopsWhenIdle
      ? `In use now. ${IDLE_TIME_COUNTED}, and it stops by itself once idle that long.`
      : `In use now. ${IDLE_TIME_COUNTED}.`;
  }
  const since = clockTime(new Date(idle.lastWorkAt).toISOString());
  const ends = clockTime(new Date(idle.idleEndsAt).toISOString());
  const ended = sampledAt !== null && idle.idleEndsAt <= sampledAt;
  // Only the host's own word that it holds a key says it will stop (#17361).
  if (idle.stopsWhenIdle) {
    return ended
      ? `Idle since ${since}. Its idle time ended ${ends}, so it stops by itself.`
      : `Idle since ${since}. It stops by itself ${ends} if it stays idle.`;
  }
  return `Idle since ${since}. Its idle time ${ended ? "ended" : "ends"} ${ends}.`;
}

/** Said where nothing current shows what a host's idle time ending does to its machine. */
export const IDLE_STOP_UNKNOWN =
  "Daintree can't tell whether the machine stops when the host's idle time ends.";

/** Said of a plugin provider's machine this device stops once idle while it's linked (#17923). */
export const LINKED_IDLE_STOP =
  "While this device is linked to the host, it stops the machine once the host's idle time ends. With every device away, the machine keeps running.";

/**
 * What a host's idle time ending does to its machine, beside its idle clock:
 * nothing more once the host says it stops the machine itself, which the
 * clock already says (#17361, #17362). Otherwise why it can't, as this device
 * found; that it doesn't, for a provider whose hosts have no way to stop their
 * machines, with what a stopped one would still cost; and unknown while the
 * provider isn't registered or its host hasn't said. A plugin provider's
 * machine this device stops while it's linked says so, with what happens with
 * every device away, or why it doesn't (#17923). `idle` is only ever from a
 * summary on the current link: one from an earlier link says nothing about now.
 */
export function idleEndSentence(
  idle: HostIdleObservation | undefined,
  provider: CloudProviderTerms | null,
  selfStopProblem: string | null,
  linkedIdleStop: CloudLinkedIdleStop | null = null
): string | null {
  if (idle?.stopsWhenIdle) return null;
  if (selfStopProblem) return selfStopProblem;
  if (provider && linkedIdleStop) {
    switch (linkedIdleStop.kind) {
      case "stops":
        return LINKED_IDLE_STOP;
      case "blocked":
        return linkedIdleStop.problem;
      case "unknown":
        return IDLE_STOP_UNKNOWN;
    }
  }
  if (provider?.hostIdleStop !== false) return IDLE_STOP_UNKNOWN;
  // Its own idle sleep or lifetime, if it has one, is described on its own.
  const doesnt = `On ${provider.name}, the machine doesn't stop when the host's idle time ends.`;
  return billsWhileStopped(provider) ? `${doesnt} ${stoppedComputeBilling(provider)}` : doesnt;
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
  if (status.machine === "stopped" && status.asleep) return "Asleep";
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
export function cloudChipStatus(
  status: CloudHostStatus,
  provider: CloudProviderTerms | null
): string {
  if (status.operation === null && status.machine === "unknown") return "state unknown";
  if (status.operation?.kind === "stopping") return "machine stopping";
  // An expired disk says why it can't start; that outranks the bill here.
  if (status.operation === null && !status.dataExpired && stoppedBillingFact(status, provider)) {
    return "stopped, still billing";
  }
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
 * and when it stops by itself. A stopped machine's rate is what a start
 * costs, unless its provider bills it while stopped too: then that is the fact.
 */
export function cloudCostFacts(
  status: CloudHostStatus,
  provider: CloudProviderTerms | null
): string[] {
  const rate = hourlyShort(status.hourlyDollars);
  const running = status.machine === "running" || status.machine === "starting";
  const facts: string[] = [];
  const stoppedBilling = stoppedBillingFact(status, provider);
  if (running) {
    if (rate) facts.push(rate);
    const stop = clockTime(status.autoStopAt);
    if (status.machine === "running") {
      // No deadline is "no auto-stop" only where the provider's model says so:
      // a fixed limit with no deadline reported is unknown, not none.
      const unreportedLimit =
        status.lifetime?.kind === "fixed-at-create" && status.lifetimeSeconds !== null;
      if (stop) facts.push(`stops by itself ${stop}`);
      else if (status.lifetime?.kind === "idle-sleep") facts.push("sleeps when idle");
      else if (status.lifetime !== null && !unreportedLimit) facts.push("no auto-stop");
    }
  } else if (stoppedBilling) {
    facts.push(stoppedBilling);
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

/** "It sleeps by itself after 30 minutes without activity.", in whatever the provider said of it. */
export function idleSleepSentence(idleSeconds: number | null): string {
  return idleSeconds === null
    ? "It sleeps by itself once it's been idle for a while."
    : `It sleeps by itself after ${durationLabel(idleSeconds)} without activity.`;
}

/**
 * When a machine stops by itself, in one sentence for anywhere a start is
 * confirmed or a create reviewed, in its provider's terms. On a renewable
 * provider Daintree pushes the stop back while the host is in use from this
 * device, so the lifetime is a guard, not a budget; a fixed limit holds even
 * then. Nothing while the provider isn't registered: its model isn't known.
 */
export function lifetimeSentence(
  lifetime: CloudLifetimeModel | null,
  lifetimeSeconds: number | null
): string {
  if (lifetime === null) return "";
  switch (lifetime.kind) {
    case "idle-sleep":
      return idleSleepSentence(lifetime.idleSeconds);
    case "none":
      return "It runs until you stop it.";
    case "fixed-at-create":
      // Nothing on the provider's side, though its host may still stop it once idle (#17362).
      return lifetimeSeconds === null
        ? "It has no runtime limit."
        : `It stops by itself ${durationLabel(lifetimeSeconds)} after starting, and that can't be extended while it runs.`;
    case "renewable":
      return lifetimeSeconds === null
        ? "It runs until you stop it."
        : `It stops by itself ${durationLabel(lifetimeSeconds)} after starting, pushed back while a window here shows it or its agents are working.`;
  }
}

/**
 * How a provider whose lifetime a create doesn't choose stops a machine, in
 * its own name: never, or by sleeping it once it's idle. Null for a provider
 * whose create does choose one.
 */
export function providerStopSentence(
  lifetime: CloudLifetimeModel,
  providerName: string
): string | null {
  switch (lifetime.kind) {
    case "none":
      return `${providerName} has no lifetime for its machines: it runs until you stop it.`;
    case "idle-sleep":
      return lifetime.idleSeconds === null
        ? `${providerName} puts it to sleep by itself once it's been idle for a while.`
        : `${providerName} puts it to sleep by itself after ${durationLabel(lifetime.idleSeconds)} without activity.`;
    default:
      return null;
  }
}

/**
 * What keeping a machine means, from what was last seen of it, and when that
 * was if it's old. `billedStopped`: its provider keeps billing a stopped
 * machine for compute until it's deleted. `storageBilled`: it bills a stopped
 * machine's disk alone until then. `addBack` for a host that leaves the list,
 * which can be added back.
 */
export function keepMachineDescription(
  status: CloudHostStatus,
  providerName: string,
  billedStopped: boolean,
  storageBilled: boolean,
  now: number,
  addBack: boolean
): string {
  const said = keepMachineState(status, providerName, billedStopped, storageBilled, addBack);
  if (status.machine === "unknown" || !isObservationStale(status, now)) return said;
  const at =
    status.observedAt !== null ? clockTime(new Date(status.observedAt).toISOString()) : null;
  return `${said} That's as of ${at ?? "the last check"}; it may have changed since.`;
}

function keepMachineState(
  status: CloudHostStatus,
  providerName: string,
  billedStopped: boolean,
  storageBilled: boolean,
  addBack: boolean
): string {
  const disk = storageBilled
    ? `, where its disk keeps billing ${status.accountName} until it's deleted`
    : "";
  const back = addBack && !status.dataExpired ? " You can add it back from Add host." : "";
  switch (status.machine) {
    case "running":
    case "starting":
      return billedStopped
        ? `It's running and keeps billing ${status.accountName} until it's deleted, even once it stops.${back}`
        : `It's running and keeps billing ${status.accountName} until it stops${status.autoStopAt ? " by itself" : ` on ${providerName}`}${storageBilled ? `, and for its disk after that until it's deleted` : ""}.${back}`;
    case "stopping":
      return billedStopped
        ? `It's stopping. Once stopped it stays in your account and keeps billing ${status.accountName} until it's deleted.${back}`
        : `It's stopping. Once stopped it stays in your account${disk}.${back}`;
    case "stopped":
      return status.dataExpired
        ? `It stays in your account, but ${providerName} has deleted its saved disk.${billedStopped ? ` It keeps billing ${status.accountName} until it's deleted.` : ""}`
        : billedStopped
          ? `It stays stopped in your account and keeps billing ${status.accountName} until it's deleted.${back}`
          : `It stays ${status.asleep ? "asleep" : "stopped"} in your account${disk}.${back}`;
    default:
      return billedStopped
        ? `Daintree can't tell whether it's running; check on ${providerName}, where it keeps billing until it's deleted.`
        : `Daintree can't tell whether it's running; check on ${providerName}, where it keeps billing while it runs${storageBilled && status.machine !== "deleted" ? `, and for its disk until it's deleted` : ""}.`;
  }
}
