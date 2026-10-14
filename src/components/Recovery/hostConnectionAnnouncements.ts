import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
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
  "up" | "lost" | "host-mode-off" | "access-denied" | "version-mismatch" | "disconnected";

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
      return current === "up" || current === "lost" ? "lost" : null;
    case "unreachable":
      return "lost";
    case "host-mode-off":
    case "access-denied":
    case "version-mismatch":
    case "disconnected":
      return variant;
  }
}

/** The one sentence a change of episode is said in; null when there's nothing to say. */
export function hostLinkAnnouncement(
  next: HostLinkEpisode,
  previous: HostLinkEpisode,
  hostName: string,
  /** The link was up before the episode being left (or, for `lost`, before this one). */
  wasUp: boolean
): string | null {
  switch (next) {
    case "up":
      if (previous === "up") return null;
      return previous === "lost" && wasUp
        ? `Reconnected to ${hostName}`
        : `Connected to ${hostName}`;
    case "lost":
      return previous === "up" && wasUp
        ? `Connection to ${hostName} lost. Terminals are read-only until it reconnects.`
        : `${hostName} is unreachable. Terminals are read-only until it reconnects.`;
    case "host-mode-off":
      return `Daintree isn't running in Host mode on ${hostName}.`;
    case "access-denied":
      return `ssh couldn't log in to ${hostName}.`;
    case "version-mismatch":
      return `${hostName} runs a different build.`;
    case "disconnected":
      return `Disconnected from ${hostName}.`;
  }
}

/**
 * What this view last said about its host's link, kept past a watcher: the
 * layout that runs the watcher is replaced once the view's state has loaded,
 * and a fresh watcher must not say the same outage again.
 */
let said: { hostId: string | null; episode: HostLinkEpisode; lostFromUp: boolean } = {
  hostId: null,
  episode: "up",
  lostFromUp: false,
};

/**
 * Say each change of this view's host link once, through the app's one
 * persistent announcer. The banner and the panes' strips stay silent: the
 * banner remounts across back-off cycles and every pane would repeat it. A
 * change that undoes itself inside the 400ms gate is never said.
 */
export function watchHostConnectionAnnouncements(hostId: string): () => void {
  const store = useHostConnectionStore;
  // A view that opens onto a link already down says so, once the gate passes.
  if (said.hostId !== hostId) said = { hostId, episode: "up", lostFromUp: false };
  // Before the store is bound to this host, or has heard the link's state,
  // nothing is known: that is no news, not a link that came back.
  const episodeOf = (state: ReturnType<typeof store.getState>, from: HostLinkEpisode) =>
    state.hostId !== hostId || state.connection === null
      ? null
      : hostLinkEpisode(selectHostBannerVariant(state), from);
  let current: HostLinkEpisode = episodeOf(store.getState(), said.episode) ?? said.episode;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settle = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (current === said.episode) return;
    timer = setTimeout(() => {
      timer = null;
      if (current === said.episode) return;
      const state = store.getState();
      const previous = said.episode;
      // Up before this loss: the link this view had, not one it never got.
      const wasUp = current === "lost" ? state.everConnected : said.lostFromUp;
      const message = hostLinkAnnouncement(
        current,
        previous,
        state.hostName ?? state.hostId ?? "The host",
        wasUp
      );
      said = {
        hostId,
        episode: current,
        lostFromUp: current === "lost" ? previous === "up" && state.everConnected : false,
      };
      if (message) useAnnouncerStore.getState().announce(message, "polite");
    }, UI_DOHERTY_THRESHOLD);
  };

  settle();
  const unsubscribe = store.subscribe((state) => {
    const next = episodeOf(state, current);
    if (next === null || next === current) return;
    current = next;
    settle();
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

export function _resetHostConnectionAnnouncementsForTesting(): void {
  said = { hostId: null, episode: "up", lostFromUp: false };
}
