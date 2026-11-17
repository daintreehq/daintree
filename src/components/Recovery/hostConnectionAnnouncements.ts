import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { olderBuildSide } from "@/components/Hosts/hostModel";
import { asSentence, wslMissingSubject } from "./recoveryCopy";
import type { HostConnectionBlocker } from "@shared/types/remoteHosts";
import {
  HOST_LINK_SETTLE_MS,
  selectHostBannerVariant,
  useHostConnectionStore,
  type HostBannerVariant,
} from "@/store/hostConnectionStore";

/**
 * What the link to the window's host is doing, as one outage rather than as
 * its attempts: a link retrying on back-off swings between reconnecting and
 * unreachable every few seconds, and all of that is one loss.
 */
export type HostLinkEpisode =
  | "up"
  | "lost"
  | "restarting"
  | "host-mode-off"
  | "access-denied"
  | "wsl-distro-missing"
  | "connection-unavailable"
  | "version-mismatch"
  | "disconnected";

/** A link down and retrying by itself: what the settle window holds back. */
function isDrop(episode: HostLinkEpisode): boolean {
  return episode === "lost" || episode === "restarting";
}

/**
 * The episode a banner variant belongs to, given the one the link is in; null
 * while a connect attempt hasn't said yet. Only a link that was up is lost by
 * reconnecting: after Host mode off, an ssh refusal or a deliberate disconnect,
 * a connect attempt is a try at getting out of that, not a new loss.
 */
export function hostLinkEpisode(
  variant: HostBannerVariant | null,
  current: HostLinkEpisode = "up"
): HostLinkEpisode | null {
  switch (variant) {
    case null:
    case "checking":
      return "up";
    case "connecting":
      return null;
    case "reconnecting":
      return current === "up" || isDrop(current) ? "lost" : null;
    case "unreachable":
      return "lost";
    case "restarting":
      return "restarting";
    case "host-mode-off":
    case "access-denied":
    case "wsl-distro-missing":
    case "connection-unavailable":
    case "version-mismatch":
    case "disconnected":
      return variant;
  }
}

/**
 * The one sentence a change of episode is said in, in the banner's words;
 * null when there's nothing to say.
 */
export function hostLinkAnnouncement(
  next: HostLinkEpisode,
  previous: HostLinkEpisode,
  hostName: string,
  /** The link was up before the episode being left (or, for a drop, before this one). */
  wasUp: boolean,
  /** Which side runs the older build, for a refused build; null when they have no order. */
  olderSide: "host" | "local" | null = null,
  /** What stopped the retries, for a missing WSL distribution or an unusable connection. */
  blocker: HostConnectionBlocker | null = null
): string | null {
  switch (next) {
    case "up":
      if (previous === "up") return null;
      return isDrop(previous) && wasUp ? `Reconnected to ${hostName}` : `Connected to ${hostName}`;
    case "lost":
      return previous === "up" && wasUp
        ? `Lost connection to ${hostName}. Terminals are read-only until it's back.`
        : `${hostName} is unreachable. Terminals are read-only until it reconnects.`;
    case "restarting":
      return `${hostName} is restarting. Terminals are read-only until it reconnects.`;
    case "host-mode-off":
      return `Daintree isn't listening on ${hostName}.`;
    case "access-denied":
      return `Couldn't log in to ${hostName} over ssh.`;
    case "wsl-distro-missing": {
      const distro = blocker?.kind === "wsl-distro-missing" ? blocker.distro : hostName;
      return `WSL couldn't find ${wslMissingSubject(distro, hostName)}. Restore it under that name, then retry.`;
    }
    case "connection-unavailable": {
      const reason = blocker?.kind === "unusable" ? asSentence(blocker.message) : "";
      return reason
        ? `Couldn't connect to ${hostName}. ${reason}`
        : `Couldn't connect to ${hostName}.`;
    }
    case "version-mismatch":
      // The banner's diagnosis and its one action, said together.
      if (olderSide === "local") {
        return `This machine runs an older version of Daintree than ${hostName}. Update this machine to connect.`;
      }
      if (olderSide === "host") {
        return `${hostName} runs an older version of Daintree. Update ${hostName} to connect.`;
      }
      return `${hostName} runs a different build of Daintree. Update ${hostName} to match this machine.`;
    case "disconnected":
      return `Disconnected from ${hostName}.`;
  }
}

/**
 * What this view last said about its host's link, kept past a watcher: the
 * layout that runs the watcher is replaced once the view's state has loaded,
 * and a fresh watcher must not say the same outage again.
 */
let said: {
  hostId: string | null;
  episode: HostLinkEpisode;
  lostFromUp: boolean;
  blocker: HostConnectionBlocker | null;
} = { hostId: null, episode: "up", lostFromUp: false, blocker: null };

function blockerIn(state: ReturnType<typeof useHostConnectionStore.getState>) {
  return state.connection?.status === "unreachable" ? (state.connection.blocker ?? null) : null;
}

/**
 * What tells one unusable connection from another: a Retry that gets past one
 * refusal (a cloud account) to the next (a host key to confirm) is news.
 */
function episodeNote(episode: HostLinkEpisode, blocker: HostConnectionBlocker | null) {
  // Compared as it is said, so the same words padded differently aren't news.
  return episode === "connection-unavailable" && blocker?.kind === "unusable"
    ? asSentence(blocker.message) || null
    : null;
}

/**
 * Say each change of this view's host link once, through the app's one
 * persistent announcer. The banner and the panes' strips stay silent: the
 * banner remounts across back-off cycles and every pane would repeat it. A
 * change that undoes itself inside the 400ms gate is never said, nor is a
 * drop from a link that was up that recovers inside the banner's settle
 * window, measured from when the link went down.
 */
export function watchHostConnectionAnnouncements(hostId: string): () => void {
  const store = useHostConnectionStore;
  // A view that opens onto a link already down says so, once the gate passes.
  if (said.hostId !== hostId) said = { hostId, episode: "up", lostFromUp: false, blocker: null };
  // Before the store is bound to this host, or has heard the link's state,
  // nothing is known: that is no news, not a link that came back.
  const episodeOf = (state: ReturnType<typeof store.getState>, from: HostLinkEpisode) =>
    state.hostId !== hostId || state.connection === null
      ? null
      : hostLinkEpisode(selectHostBannerVariant(state), from);
  const opening = episodeOf(store.getState(), said.episode);
  let current: HostLinkEpisode = opening ?? said.episode;
  // Taken with the state that settled the episode: by the time it is said, a
  // Retry may have the link dialling again, with no blocker on it.
  let blocker = opening === null ? said.blocker : blockerIn(store.getState());
  const alreadySaid = () =>
    current === said.episode &&
    episodeNote(current, blocker) === episodeNote(said.episode, said.blocker);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let downSince: number | null = current === "up" ? null : Date.now();

  const settle = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (current === "up") downSince = null;
    else downSince ??= Date.now();
    if (alreadySaid()) return;
    const dropFromUp = isDrop(current) && said.episode === "up" && store.getState().everConnected;
    const delay =
      dropFromUp && downSince !== null
        ? Math.max(UI_DOHERTY_THRESHOLD, HOST_LINK_SETTLE_MS - (Date.now() - downSince))
        : UI_DOHERTY_THRESHOLD;
    timer = setTimeout(() => {
      timer = null;
      if (alreadySaid()) return;
      const state = store.getState();
      const previous = said.episode;
      // Up before this loss: the link this view had, not one it never got.
      const wasUp = isDrop(current) ? state.everConnected : said.lostFromUp;
      const message = hostLinkAnnouncement(
        current,
        previous,
        state.hostName ?? state.hostId ?? "The host",
        wasUp,
        state.connection?.status === "version-mismatch"
          ? olderBuildSide(state.connection.mismatch)
          : null,
        blocker
      );
      said = {
        hostId,
        episode: current,
        lostFromUp: isDrop(current)
          ? (previous === "up" && state.everConnected) || (isDrop(previous) && said.lostFromUp)
          : false,
        blocker,
      };
      if (message) useAnnouncerStore.getState().announce(message, "polite");
    }, delay);
  };

  settle();
  const unsubscribe = store.subscribe((state) => {
    const next = episodeOf(state, current);
    if (next === null) return;
    const nextBlocker = blockerIn(state);
    const changed =
      next !== current || episodeNote(next, nextBlocker) !== episodeNote(current, blocker);
    current = next;
    blocker = nextBlocker;
    if (changed) settle();
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

export function _resetHostConnectionAnnouncementsForTesting(): void {
  said = { hostId: null, episode: "up", lostFromUp: false, blocker: null };
}
