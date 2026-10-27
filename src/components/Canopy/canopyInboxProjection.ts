import type { HostId } from "@shared/types/remoteHosts";
import { itemNeedsAttention, itemPutAside, type CanopyItem } from "./canopyModel";
import type { CanopyAssistantItem } from "./canopyAssistants";

export interface CanopyWorkerEntry {
  role: "worker";
  /** Unique across hosts and roles. */
  key: string;
  /** The host it runs on; null for the window's own. */
  hostId: HostId | null;
  item: CanopyItem;
}

export interface CanopyAssistantEntry {
  role: "assistant";
  key: string;
  hostId: HostId | null;
  item: CanopyAssistantItem;
}

/** One run in the inbox, worker or assistant, named so no host or role can collide with another. */
export type CanopyInboxEntry = CanopyWorkerEntry | CanopyAssistantEntry;

export function isWorkerEntry(entry: CanopyInboxEntry): entry is CanopyWorkerEntry {
  return entry.role === "worker";
}

export interface CanopyInboxProjectionInput {
  ownHostId: HostId;
  /** Every worker in the inbox, archived ones aside, whatever the filters show. */
  workers: readonly CanopyItem[];
  /** The workers in the Needs you band, by run id: held with the order, not read afresh. */
  band: ReadonlySet<string>;
  /** Every assistant, whatever the filters show. */
  assistants: readonly CanopyAssistantItem[];
  /** The workers listed, in the order shown. */
  listedWorkers: readonly CanopyItem[];
  /** The assistants listed, in the order shown. */
  shownAssistants: readonly CanopyAssistantItem[];
  /** The assistants asking for the user sit in the Needs you band, after the workers there. */
  askingAssistantsInBand: boolean;
  /** The archived workers shown; none while their fold is shut. */
  shownArchived: readonly CanopyItem[];
  /** Where a worker really runs: its host (null for the window's own) and its id there. */
  workerPlace: (item: CanopyItem) => { hostId: HostId | null; runId: string };
}

export interface CanopyInboxProjection {
  /** Everything in the inbox, workers then assistants, unfiltered. */
  inbox: CanopyInboxEntry[];
  /**
   * What needs the user, in inbox order: what the header counts. A worker is
   * counted while it is in the band and still needs the user, so one held
   * there after a reply isn't, and one newly over the floor waits for the band.
   */
  needsYou: CanopyInboxEntry[];
  /**
   * What the keyboard walks, top to bottom as drawn: the band's workers, the
   * band's assistants, the other listed workers, the other assistants, then
   * the shown archived workers.
   */
  navigation: CanopyInboxEntry[];
}

/**
 * Whether the user is wanted: for a worker, what Daintree observed or the
 * readers placed (#14504's shelf included); for an assistant, only what its own
 * run was observed asking. Assistants are never read by the model.
 */
export function entryNeedsYou(entry: CanopyInboxEntry): boolean {
  return entry.role === "worker" ? itemNeedsAttention(entry.item) : entry.item.ask !== null;
}

/** Put aside by the user, parked or snoozed: an assistant never is. */
export function entryShelved(entry: CanopyInboxEntry): boolean {
  return entry.role === "worker" && itemPutAside(entry.item);
}

function entryUnread(entry: CanopyInboxEntry): boolean {
  return entry.role === "worker" && entry.item.unread;
}

export function projectCanopyInbox(input: CanopyInboxProjectionInput): CanopyInboxProjection {
  const own = (hostId: HostId | null) => (hostId === input.ownHostId ? null : hostId);
  // Each built once, so the same run is the same entry in every list it is in.
  const workerEntries = new Map<CanopyItem, CanopyWorkerEntry>();
  const worker = (item: CanopyItem): CanopyWorkerEntry => {
    let entry = workerEntries.get(item);
    if (entry === undefined) {
      const place = input.workerPlace(item);
      const hostId = own(place.hostId);
      entry = {
        role: "worker",
        key: JSON.stringify(["worker", hostId ?? input.ownHostId, place.runId]),
        hostId,
        item,
      };
      workerEntries.set(item, entry);
    }
    return entry;
  };
  const assistantEntries = new Map<CanopyAssistantItem, CanopyAssistantEntry>();
  const assistant = (item: CanopyAssistantItem): CanopyAssistantEntry => {
    let entry = assistantEntries.get(item);
    if (entry === undefined) {
      entry = { role: "assistant", key: item.id, hostId: own(item.subject.hostId), item };
      assistantEntries.set(item, entry);
    }
    return entry;
  };
  const inbox = [...input.workers.map(worker), ...input.assistants.map(assistant)];
  const inBand = (item: CanopyItem) => input.band.has(item.runId);
  const bandWorkers = input.listedWorkers.filter(inBand);
  const restWorkers = input.listedWorkers.filter((item) => !inBand(item));
  const asking = (item: CanopyAssistantItem) => input.askingAssistantsInBand && item.ask !== null;
  return {
    inbox,
    needsYou: inbox.filter(
      (entry) => entryNeedsYou(entry) && (entry.role === "assistant" || inBand(entry.item))
    ),
    navigation: [
      ...bandWorkers.map(worker),
      ...input.shownAssistants.filter(asking).map(assistant),
      ...restWorkers.map(worker),
      ...input.shownAssistants.filter((item) => !asking(item)).map(assistant),
      ...input.shownArchived.map(worker),
    ],
  };
}

/**
 * The entry a step up or down lands on, clamped at the ends. From nothing
 * selected, down enters at the top and up at the bottom.
 */
export function stepEntry<T extends CanopyInboxEntry>(
  order: readonly T[],
  key: string | null,
  direction: -1 | 1
): T | undefined {
  if (order.length === 0) return undefined;
  const index = key === null ? -1 : order.findIndex((entry) => entry.key === key);
  if (index === -1) return order[direction > 0 ? 0 : order.length - 1];
  return order[Math.min(order.length - 1, Math.max(0, index + direction))];
}

/**
 * Where the cursor goes once an entry is dealt with — archived, answered,
 * replied to: the next one after it that needs you or has something unread,
 * else the first before it that does, else simply its neighbour. Never onto a
 * run the user put aside, unless it is the only neighbour left.
 */
export function nextAfterEntry<T extends CanopyInboxEntry>(
  order: readonly T[],
  key: string | null
): T | undefined {
  const index = key === null ? -1 : order.findIndex((entry) => entry.key === key);
  const wanted = (entry: T) =>
    entry.key !== key && !entryShelved(entry) && (entryNeedsYou(entry) || entryUnread(entry));
  return (
    order.slice(index + 1).find(wanted) ??
    order.slice(0, Math.max(index, 0)).find(wanted) ??
    (index === -1 ? undefined : (order[index + 1] ?? order[index - 1]))
  );
}
