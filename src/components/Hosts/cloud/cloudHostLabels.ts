import { pluralize } from "@/lib/pluralize";
import {
  cloudMachineLabel,
  type CloudHostStatus,
  type CloudLifetimeModel,
  type CloudKeepAwake,
  type CloudLinkedIdleStop,
  type CloudProviderInfo,
  type CloudProviderPersistence,
} from "@shared/types/cloudHosts";
import type { HostIdleObservation } from "@shared/types/hostIdle";

/** The parts of a provider's declaration that decide what stopping and deleting mean. */
export type CloudProviderTerms = Pick<
  CloudProviderInfo,
  "name" | "capabilities" | "hostIdleStop" | "stopMode"
>;

/**
 * Its machines can't stop and start again, so Delete is the only way one
 * ends (#18227). Unknown while the provider isn't registered: nothing is
 * taken away on a guess.
 */
export function isDeleteOnly(
  provider: Pick<CloudProviderInfo, "stopMode"> | null | undefined
): boolean {
  return provider?.stopMode === "delete-only";
}

/** Said of a machine that has no stop, where a stop or a kept disk would otherwise be. */
export const DELETE_ONLY_RUNS = "It runs, and bills, until it's deleted.";

/** What deleting a machine that has no stop costs, said wherever its end is described. */
export const DELETE_ONLY_LOSS = "Deleting it loses everything on it, its disk included.";

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
  // A machine that never stops has no stopped rate to describe.
  if (!provider || isDeleteOnly(provider)) return null;
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

/** What starting a machine bills, said where the start is decided. */
export function startBillingSentence(
  status: Pick<CloudHostStatus, "accountName" | "hourlyDollars" | "machine">,
  provider: CloudProviderTerms | null
): string {
  const hourly =
    status.hourlyDollars !== null
      ? `about $${status.hourlyDollars.toFixed(3)} an hour`
      : "for the time it runs";
  const stopped = stoppedBillingSentence(provider);
  // Starting doesn't start the billing there: the stopped machine is billed already.
  return stopped && status.machine === "stopped"
    ? `It bills ${status.accountName} ${hourly} while it runs. ${stopped}`
    : `Starting it bills ${status.accountName} ${hourly} while it runs.`;
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

/** A month of running, as providers quote one: 730 hours. */
const HOURS_PER_MONTH = 730;

/** "$0.036 an hour · about $26.28 a month", for an offer's quoted rate. */
export function offerPriceLabel(hourlyDollars: number): string {
  const monthly = (hourlyDollars * HOURS_PER_MONTH).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${hourlyDollars.toFixed(3)} an hour · about $${monthly} a month`;
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

/** "Wed 26 Nov, 15:00" in this device's locale, for a time up to weeks away. */
export function dayTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
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

/** What the details know of a machine whose provider sleeps it once its host's idle time ends (#17916). */
export interface IdleSleepMachine {
  /** This device's link to the host is up. */
  connected: boolean;
  /** The machine's own idle sleep, as its provider last reported it. */
  lifetime: CloudLifetimeModel | null;
  /** Its own idle timeout follows the host's idle time (`CloudHostStatus.idleTimeFollowsHost`). */
  followsHost: boolean;
  /** The link the host sends requests through while it sees work (`CloudHostStatus.keepAwake`, #17918). */
  keepAwake?: CloudKeepAwake | null;
}

const UNKNOWN_SLEEPER: IdleSleepMachine = { connected: false, lifetime: null, followsHost: true };

/**
 * Which timer puts a machine to sleep on a provider whose own idle timer an
 * open link keeps from running, Agent 37's (#17916): the host's idle time
 * while this device is connected, the provider's own otherwise. An imported
 * machine's own timer keeps its own length until the person picks one here.
 */
export function idleSleepTimerSentence(
  provider: Pick<CloudProviderTerms, "name">,
  idle: HostIdleObservation | undefined,
  machine: IdleSleepMachine
): string {
  const name = provider.name;
  const lifetime = machine.lifetime;
  if (lifetime?.kind === "none") {
    return `Sleeping when idle is off for this machine on ${name}, so nothing puts it to sleep. Picking an idle time turns it on.`;
  }
  const own = lifetime?.kind === "idle-sleep" ? lifetime.idleSeconds : null;
  const ownTimer = `${name}'s own idle timer${own === null ? "" : ` (${durationLabel(own)})`}`;
  const afterIdle =
    own === null
      ? "once it's been idle for a while"
      : `after ${durationLabel(own)} without activity`;
  const away = awaySentence(name, ownTimer, afterIdle, machine);
  const inCharge = machine.connected
    ? `The host's idle time is in charge while this device is connected, since the connection keeps ${ownTimer} from running: once it ends, Daintree checks with the host and puts the machine to sleep.${away.connected ? ` ${away.connected}` : ""}`
    : `${away.offline} The host's idle time takes over while this device is connected.`;
  const differs =
    !machine.followsHost &&
    idle !== undefined &&
    own !== null &&
    own !== idle.idleAfterMinutes * 60;
  return differs
    ? `${inCharge} ${name} keeps its own idle timer until you pick an idle time here.`
    : inCharge;
}

/**
 * What the host does about the machine's idle timer with no device connected
 * (#17918), and what this device saw of it (#17976): the host sends requests
 * through the link this device last heard it holds while it sees work, and
 * when its last one reached it; otherwise the provider's own timer, with why.
 * Whether the provider counts those requests is its own, so nothing here says
 * they kept the machine awake. `connected` is said after the connected
 * sentence, and is null when there is nothing worth adding there; `offline`
 * stands on its own.
 */
function awaySentence(
  name: string,
  ownTimer: string,
  afterIdle: string,
  machine: IdleSleepMachine
): { connected: string | null; offline: string } {
  const keepAwake = machine.keepAwake ?? null;
  const seen = keepAwake ? seenSentences(name, keepAwake) : "";
  const withSeen = (text: string) => (seen ? `${text} ${seen}` : text);
  const ownInCharge = `${sentenceCase(ownTimer)} is in charge while no device is connected`;
  if (keepAwake?.kind === "held") {
    const said = machine.connected ? "" : ` (as the host said ${dayTime(keepAwake.confirmedAt)})`;
    const last =
      keepAwake.lastRequestAt !== undefined
        ? ` Its last request reached it ${dayTime(keepAwake.lastRequestAt)}.`
        : keepAwake.reached
          ? ""
          : " No request through it has reached the host yet.";
    const held = withSeen(
      `With no device connected, the host sends requests through a link from Daintree while it sees work${said}.${last} The link expires ${dayTime(keepAwake.expiresAt)}. ${sentenceCase(ownTimer)} puts the machine to sleep ${afterIdle}.`
    );
    return { connected: held, offline: held };
  }
  if (keepAwake?.kind === "expired") {
    const expired = `${ownInCharge}, even while the host sees work: the link from Daintree the host held expired ${dayTime(keepAwake.expiredAt)}.`;
    return { connected: withSeen(expired), offline: withSeen(`${expired} Connecting renews it.`) };
  }
  if (keepAwake?.kind === "none" && keepAwake.problem) {
    const problem = /[.!?]$/.test(keepAwake.problem) ? keepAwake.problem : `${keepAwake.problem}.`;
    const refused = withSeen(`${ownInCharge}, even while the host sees work: ${problem}`);
    return { connected: refused, offline: refused };
  }
  const own = withSeen(`${ownInCharge}: it puts the machine to sleep ${afterIdle}.`);
  // The host said it holds none: said while connected too, where someone decides to leave.
  if (keepAwake?.kind === "none") return { connected: own, offline: own };
  return { connected: null, offline: own };
}

/** "3 minutes", "2 hours", "less than a minute": how far apart two times are. */
function apart(ms: number): string {
  if (ms < 60_000) return "less than a minute";
  return durationLabel(Math.round(ms / 60_000) * 60);
}

/**
 * What this device saw beside the link (#17976): a sleep the provider
 * reported, with how long after the host's last request it came, and a gap
 * the host saw in its own passes with no sleep reported, of unknown cause.
 * The last request itself is said with the link while one is held.
 */
function seenSentences(
  name: string,
  keepAwake: NonNullable<IdleSleepMachine["keepAwake"]>
): string {
  const out: string[] = [];
  // Said once: with the link while one is held, or with the sleep when that's the one it follows.
  if (
    keepAwake.kind !== "held" &&
    keepAwake.lastRequestAt !== undefined &&
    keepAwake.lastRequestAt !== keepAwake.sleep?.lastRequestAt
  ) {
    out.push(`The host's last request reached it ${dayTime(keepAwake.lastRequestAt)}.`);
  }
  const sleep = keepAwake.sleep;
  if (sleep) {
    const after =
      sleep.lastRequestAt !== null && sleep.lastRequestAt <= sleep.sleptAt
        ? `, ${apart(sleep.sleptAt - sleep.lastRequestAt)} after the host's last request this device heard of`
        : "";
    out.push(`${name} put it to sleep ${dayTime(sleep.sleptAt)}${after}.`);
  }
  const gap = keepAwake.gap;
  if (gap) {
    out.push(
      `Before ${dayTime(gap.to)}, the host's checks for work came late or its clock jumped, for a reason it can't tell. ${name} reported no sleep then.`
    );
  }
  return out.join(" ");
}

/**
 * Said after why a machine can't stop itself, where this device stops it
 * instead while linked (#17924). Nothing about every device being away: a
 * machine with a runtime limit still stops when that runs out.
 */
export const LINKED_IDLE_STOP_INSTEAD =
  "While this device is linked to the host, it stops the machine once the host's idle time ends instead.";

function sentences(first: string, second: string): string {
  return `${/[.!?]$/.test(first) ? first : `${first}.`} ${second}`;
}

/**
 * What a host's idle time ending does to its machine, beside its idle clock:
 * nothing more once the host says it stops the machine itself, which the
 * clock already says (#17361, #17362). Otherwise why it can't, as this device
 * found; which timer is in charge, where this device puts the machine to
 * sleep while connected (#17916); that it doesn't, for a provider whose hosts
 * have no way to stop their machines, with what a stopped one would still
 * cost; and unknown while the provider isn't registered or its host hasn't
 * said. A plugin provider's machine this device stops while it's linked says
 * so, with what happens with every device away, or why it doesn't (#17923). A
 * machine that can't stop itself, where this device stops it instead, says
 * both, as does one where a stop from here is blocked too (#17924). `idle` is
 * only ever from a summary on the current link: one from an earlier link says
 * nothing about now.
 */
export function idleEndSentence(
  idle: HostIdleObservation | undefined,
  provider: CloudProviderTerms | null,
  selfStopProblem: string | null,
  linkedIdleStop: CloudLinkedIdleStop | null = null,
  machine: IdleSleepMachine = UNKNOWN_SLEEPER
): string | null {
  if (idle?.stopsWhenIdle) return null;
  if (selfStopProblem) {
    if (provider && linkedIdleStop?.kind === "stops") {
      return sentences(selfStopProblem, LINKED_IDLE_STOP_INSTEAD);
    }
    if (provider && linkedIdleStop?.kind === "blocked") {
      return sentences(selfStopProblem, linkedIdleStop.problem);
    }
    return selfStopProblem;
  }
  if (provider && linkedIdleStop) {
    switch (linkedIdleStop.kind) {
      case "stops":
        return LINKED_IDLE_STOP;
      case "sleeps":
        return idleSleepTimerSentence(provider, idle, machine);
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
  // Ahead of the create under way: nothing more happens until the person chooses, and
  // the first offer they can choose is the change worth hearing.
  if (status.pendingCreate) {
    return status.pendingCreate.offers.some((offer) => offer.choosable)
      ? "Offers ready"
      : "Waiting for offers";
  }
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
  if (status.pendingCreate) return word;
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
      else if (isDeleteOnly(provider)) facts.push("runs until deleted");
      else if (status.lifetime?.kind === "idle-sleep") facts.push("sleeps when idle");
      else if (status.lifetime !== null && !unreportedLimit) facts.push("no auto-stop");
    }
  } else if (stoppedBilling) {
    facts.push(stoppedBilling);
  } else if (rate && canStartMachine(status, provider)) {
    facts.push(`${rate} when started`);
  }
  return facts;
}

/**
 * The machine can be started by a person now. Never on a provider that has no
 * stop; on one that isn't registered, as its status says.
 */
export function canStartMachine(
  status: CloudHostStatus,
  provider: Pick<CloudProviderInfo, "stopMode"> | null = null
): boolean {
  return (
    !isDeleteOnly(provider) &&
    status.operation === null &&
    status.resourceId !== null &&
    !status.dataExpired &&
    (status.machine === "stopped" || status.machine === "error")
  );
}

/** The machine can be stopped by a person now: never on a provider that has no stop. */
export function canStopMachine(
  status: CloudHostStatus,
  provider: Pick<CloudProviderInfo, "stopMode"> | null = null
): boolean {
  return (
    !isDeleteOnly(provider) &&
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
 * A provider that has no stop runs its machines until they're deleted.
 */
export function lifetimeSentence(
  lifetime: CloudLifetimeModel | null,
  lifetimeSeconds: number | null,
  provider: Pick<CloudProviderInfo, "stopMode"> | null = null
): string {
  if (isDeleteOnly(provider)) return DELETE_ONLY_RUNS;
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
 * whose create does choose one. One that has no stop runs them until they're deleted.
 */
export function providerStopSentence(
  lifetime: CloudLifetimeModel,
  providerName: string,
  stopMode?: CloudProviderInfo["stopMode"]
): string | null {
  if (stopMode === "delete-only") {
    return `${providerName} has no stop: a machine runs, and bills, until it's deleted.`;
  }
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
 * which can be added back. `deleteOnly`: its provider has no stop, so it bills
 * until it's deleted.
 */
export function keepMachineDescription(
  status: CloudHostStatus,
  providerName: string,
  billedStopped: boolean,
  storageBilled: boolean,
  now: number,
  addBack: boolean,
  deleteOnly = false
): string {
  const said = deleteOnly
    ? keepDeleteOnlyState(status, providerName, addBack)
    : keepMachineState(status, providerName, billedStopped, storageBilled, addBack);
  if (status.machine === "unknown" || !isObservationStale(status, now)) return said;
  const at =
    status.observedAt !== null ? clockTime(new Date(status.observedAt).toISOString()) : null;
  return `${said} That's as of ${at ?? "the last check"}; it may have changed since.`;
}

function keepDeleteOnlyState(
  status: CloudHostStatus,
  providerName: string,
  addBack: boolean
): string {
  const back = addBack ? " You can add it back from Add host." : "";
  switch (status.machine) {
    case "running":
    case "starting":
    case "stopping":
      return `It keeps running, and billing ${status.accountName}, until it's deleted.${back}`;
    case "deleted":
      return `${providerName} last reported it deleted.`;
    default:
      return `Daintree can't tell whether it's running; check on ${providerName}, where it keeps billing until it's deleted.`;
  }
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
