import { useSyncExternalStore } from "react";
import type { PluginProjectPresenceState } from "../../../../shared/types/plugin.js";
import {
  PLUGIN_VIEW_RESYNC_EVENT,
  toPluginProjectPresence,
} from "../../../../shared/utils/pluginProjectPresence.js";
import { getPluginHostBridge, type PluginHostBridge } from "./hostBridge.js";

// One store per view document: every component asking shares one bridge
// subscription. A view's project never changes over its life, so once main has
// named it the answer only ever moves with pushes for that project.
let state: PluginProjectPresenceState | null = null;
/** `undefined` until main has answered; `null` once it said this view has no project. */
let projectId: string | null | undefined;
let bridgeInUse: PluginHostBridge | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: PluginProjectPresenceState | null): void {
  if (next === state) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

function start(bridge: PluginHostBridge): () => void {
  if (bridge !== bridgeInUse) {
    bridgeInUse = bridge;
    projectId = undefined;
    state = null;
  }
  const { getProjectPresence, onProjectPresenceChanged } = bridge;
  if (typeof getProjectPresence !== "function" || typeof onProjectPresenceChanged !== "function") {
    return () => {};
  }
  let live = true;
  let reading = false;
  let again = false;
  // A push is never older than a read it raced — any change after it pushes
  // again — so pushes win. These count this project's pushes since the read in
  // flight began, and keep, per project, the latest push that landed while main
  // had not named this view's project, to apply once it has.
  let pushes = 0;
  const unattributed = new Map<string, PluginProjectPresenceState>();
  const read = (): void => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    again = false;
    const seen = pushes;
    getProjectPresence.call(bridge).then(
      (value) => {
        reading = false;
        if (!live) return;
        const presence = toPluginProjectPresence(value);
        projectId = presence?.projectId ?? null;
        const pushed = presence ? unattributed.get(presence.projectId) : undefined;
        unattributed.clear();
        if (pushed !== undefined) publish(pushed);
        else if (pushes === seen) publish(presence?.state ?? null);
        if (again) read();
      },
      () => {
        // A failed read is no answer: keep the last one rather than guess, and
        // let the next push or resync ask again.
        reading = false;
        if (live && again) read();
      }
    );
  };
  // Subscribed before the read, so a change between the two is not lost.
  const off = onProjectPresenceChanged.call(bridge, (payload) => {
    if (!live) return;
    const presence = toPluginProjectPresence(payload);
    if (!presence) return;
    if (typeof projectId === "string") {
      if (presence.projectId !== projectId) return;
      pushes += 1;
      publish(presence.state);
      return;
    }
    // Not attributable yet: main has not answered, or answered before this
    // view was registered to a project, which a view that loads first outgrows.
    unattributed.set(presence.projectId, presence.state);
    if (!reading) read();
  });
  // A remote view's link dropped pushes on the way: read again once it is back.
  const onResync = (): void => {
    if (live) read();
  };
  const target = typeof window === "undefined" ? null : window;
  target?.addEventListener(PLUGIN_VIEW_RESYNC_EVENT, onResync);
  // Re-read on every first subscriber: pushes are not heard while nobody is.
  read();
  return () => {
    live = false;
    off();
    target?.removeEventListener(PLUGIN_VIEW_RESYNC_EVENT, onResync);
  };
}

function subscribe(onChange: () => void): () => void {
  if (listeners.size === 0) stop = start(getPluginHostBridge());
  listeners.add(onChange);
  return () => {
    if (!listeners.delete(onChange) || listeners.size > 0) return;
    stop?.();
    stop = null;
  };
}

const getSnapshot = (): PluginProjectPresenceState | null => state;
const getServerSnapshot = (): null => null;

/**
 * Where this view's project is: `"foreground"` while a window shows it,
 * `"background"` while it is open behind another, `"closed"` as it closes —
 * the answer `host.onDidChangeProjectPresence` gives the worker for the same
 * project (#13813). `null` until main has answered, in a view with no project,
 * and on a Daintree that predates the signal.
 *
 * Use it to slow a poll down while the project is in the background and
 * catch up when it returns; `document.visibilityState` cannot tell, because a
 * project switched away from keeps reporting its window's visibility. Presence
 * is not attention: a minimised or unfocused window's project is still in the
 * foreground, so AND it with document visibility where that matters.
 */
export function useProjectPresence(): PluginProjectPresenceState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
