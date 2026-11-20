import { RelayClient } from "@daintreehq/decisions-client";
import type { EventsPage, ProtocolFeature } from "@daintreehq/decisions-protocol";

/**
 * The protocol extensions (Decisions protocol section 19) Daintree declares to
 * its relay (#16229). A relay sends a desktop only what it declared, and a
 * phone offers follow-ups, images or a terminal refresh on a question only
 * when the desktop that asked it declared that feature, so each one joins
 * this list with the Daintree work that handles it: follow-ups with their
 * typing (#16231), pane snapshots with #16230, which a bridge asks for only
 * when its connection publishes them, phone images with their storing
 * (#16233), the involvement preference's change hints with
 * `get_involvement` (#17228), and the person's answers the owner desktop
 * signs with their typing as answers made on the computer (#17101), and the
 * person's follow-ups it signs with their typing as sent from the computer
 * (#17238), each of which a relay commits to a question only once the
 * desktop that asked it declared it, the owner's own and a Remote Host's
 * alike. A person's decline from a phone (#17234) joins with its typing as a
 * declined notice and its showing as declined, so a phone offers Dismiss on
 * Daintree's questions, and the person's decline the owner desktop signs
 * (#17239) joins with the view that signs it, filed and typed the same way:
 * declared here, it lets the owner decline this computer's questions, and
 * each Remote Host's once that Host runs this Daintree. `presence-v1` is a
 * relay's to advertise in `/info`, never a desktop's to declare: presence
 * (#17240) is reported only to a relay that lists it. Setting the involvement
 * preference from this computer (#17237) has no token of its own: it rides
 * `involvement-v1`. `advisory-deadlines-v1` says three things by who
 * declares it: in a relay's `/info`, that it takes advisory creates; on a
 * phone's ticket, that it shows the deadline and the plan; on a desktop's,
 * that its host delivers advisory outcomes to its agents. It joins with the
 * work that types the advisory notice into the pane that asked (#17941), and
 * only a bridge given `advisoryDeadlines` asks to declare it: the owner's,
 * once its delivery runs. A Remote Host's bridge isn't given it until the
 * Host settles its own deadlines (#17942), so it never declares it.
 * `agent-stopped-push-v1`, like presence, is a relay's to advertise: the owner
 * desktop asks for that push (#17319) only of a relay that lists it.
 */
export const DAINTREE_PROTOCOL_FEATURES: readonly ProtocolFeature[] = [
  "thread-messages-v1",
  "pane-snapshots-v1",
  "phone-images-v1",
  "involvement-v1",
  "owner-desktop-answers-v1",
  "owner-desktop-messages-v1",
  "person-declines-v1",
  "owner-desktop-declines-v1",
  "advisory-deadlines-v1",
];

/**
 * Whether this Daintree delivers an advisory question's outcome to the agent
 * that asked it (protocol section 21): the host support a bridge needs before
 * it signs one (`BridgeOptions.advisoryDeadlines`). The terminal sink reads
 * and types the advisory notice, a reopen or deletion stored for its question
 * keeps it off a pane it hasn't reached yet, and it goes only to the run that
 * asked or a resume of its session (#17941). Given to the owner's lifetimes
 * alone (`DecisionsService`), and only once their delivery runs.
 */
export const DAINTREE_DELIVERS_ADVISORY_OUTCOMES: boolean = true;

function declared(features: readonly ProtocolFeature[]): ProtocolFeature[] {
  return features.filter((feature) => DAINTREE_PROTOCOL_FEATURES.includes(feature));
}

/**
 * The library's client, declaring only `DAINTREE_PROTOCOL_FEATURES` on its
 * socket tickets and event pages, so a feature a later bridge asks for is
 * cut here, before the request is signed, until Daintree handles it.
 */
export class DaintreeRelayClient extends RelayClient {
  override events(
    after: number,
    limit?: number,
    features: readonly ProtocolFeature[] = [],
    opts?: Parameters<RelayClient["events"]>[3]
  ): Promise<EventsPage> {
    return super.events(after, limit, declared(features), opts);
  }

  override socketTicket(
    features: readonly ProtocolFeature[] = [],
    opts?: Parameters<RelayClient["socketTicket"]>[1]
  ): ReturnType<RelayClient["socketTicket"]> {
    return super.socketTicket(declared(features), opts);
  }
}
