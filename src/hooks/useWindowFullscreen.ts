import { useSyncExternalStore } from "react";

// Main says when the window enters or leaves fullscreen, never what it is now,
// so a surface that mounts after the change would start out windowed. The
// state is kept here from the first subscriber on (the toolbar, mounted with
// the view) for every surface that mounts later.
let fullscreen = false;
let subscribed = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (!subscribed) {
    const unsubscribe = window.electron?.window?.onFullscreenChange?.((next) => {
      fullscreen = next;
      for (const notify of listeners) notify();
    });
    subscribed = unsubscribe !== undefined;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => fullscreen;

/** Whether the window is fullscreen, where the OS window controls are gone. */
export function useWindowFullscreen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
