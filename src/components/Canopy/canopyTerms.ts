/** The dialog's title, the same in every state it renders: the feature named in full. */
export const CANOPY_TITLE = "Daintree Canopy";

/** The beta's terms, word for word on the pitch, in the inbox notice and in Settings. */
export const CANOPY_BETA_TERMS =
  "Canopy is free and unlimited during the beta. It becomes a paid feature after that.";

/**
 * What turning Canopy on sends, and when: said the same way wherever the user
 * can turn it on — the offer and Settings — so consent given in either place
 * covers the same thing.
 */
export const CANOPY_SENDS =
  "To read them, Canopy sends your agents' terminal output to Daintree's servers: what's on screen, recent scrollback with the requests you typed, each terminal's title and state, and notes Canopy kept from earlier readings. It does this for agents in every project, and while it's closed too, so it can tell you when an agent is asking for you.";

/** What redaction does, without promising more than pattern matching can. */
export const CANOPY_REDACTION =
  "Common key and password patterns are removed before sending. This can miss some secrets.";

/** How to take the consent back. */
export const CANOPY_STOP = "Stop at any time from Settings > Canopy.";

/** The policy that covers what Canopy sends. */
export const CANOPY_PRIVACY_URL = "https://daintree.org/privacy";

/** Where the waitlist for Canopy's paid plan lives. */
export const CANOPY_WAITLIST_URL = "https://daintree.org/canopy";

/**
 * What turning Canopy on sends from another host: the same consent as
 * `CANOPY_SENDS`, said of that host, whose own Canopy does the reading.
 */
export function canopySendsFrom(hostName: string): string {
  return `To read them, Canopy on ${hostName} sends its agents' terminal output to Daintree's servers: what's on screen, recent scrollback with the requests typed there, each terminal's title and state, and notes Canopy kept from earlier readings. It does this for agents in every project on ${hostName}, and while Canopy is closed too, so it can tell you when an agent is asking for you.`;
}

/** How to take another host's consent back. */
export function canopyStopOn(hostName: string): string {
  return `Stop at any time from Settings > Canopy on ${hostName}.`;
}
