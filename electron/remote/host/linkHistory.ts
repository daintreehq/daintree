import type { HostLinkEvent } from "../../../shared/types/ipc/hostMetrics.js";
import { MAX_LINK_HISTORY, MAX_LINK_HISTORY_TEXT } from "../metrics/linkMethods.js";

type Refusal = Extract<HostLinkEvent, { kind: "refused" }>;

/**
 * What a host's listener saw happen to its links, in memory only: a restart
 * starts it afresh. Ids, names and reasons, never a token, a resume secret or
 * anything a session carried.
 */
export class LinkHistory {
  private readonly events: HostLinkEvent[] = [];
  private truncated = false;

  constructor(private readonly max = MAX_LINK_HISTORY) {}

  record(event: HostLinkEvent): void {
    this.events.push(event);
    if (this.events.length > this.max) {
      this.events.shift();
      this.truncated = true;
    }
  }

  /**
   * A launch retrying into the refusal it last got, with nothing admitted in
   * between, counts on that entry rather than filling the list.
   */
  refused(event: Omit<Refusal, "kind" | "count" | "lastAt">, repeat: boolean): void {
    if (repeat) {
      for (let i = this.events.length - 1; i >= 0; i--) {
        const entry = this.events[i]!;
        if (entry.clientId !== event.clientId) continue;
        if (
          entry.kind === "refused" &&
          entry.reason === event.reason &&
          entry.detail === event.detail
        ) {
          entry.count += 1;
          entry.lastAt = event.at;
          return;
        }
        break;
      }
    }
    this.record({ ...event, kind: "refused", count: 1, lastAt: event.at });
  }

  /** Newest first, as copies. */
  list(): { events: HostLinkEvent[]; truncated: boolean } {
    return {
      events: this.events.map((event) => ({ ...event })).reverse(),
      truncated: this.truncated,
    };
  }
}

export function historyText(text: string): string {
  return text.length > MAX_LINK_HISTORY_TEXT ? text.slice(0, MAX_LINK_HISTORY_TEXT) : text;
}
