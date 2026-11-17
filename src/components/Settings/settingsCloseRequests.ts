/** A request, from outside Settings, for it to close the way its own Close does. */
export interface SettingsCloseRequest {
  /** The dialog is open and takes the request: its answer comes through `settle`. */
  claim(): void;
  /** Settings has closed and handed focus back (true), or opened again first (false). */
  settle(closed: boolean): void;
}

type Listener = (request: SettingsCloseRequest) => void;

const listeners = new Set<Listener>();

/**
 * Close Settings, then run `next`: once it has gone and handed focus back, so
 * what `next` opens can take focus. An unsaved setting holds the close as it
 * holds the dialog's own, and `next` waits until Settings does close. With
 * Settings not open, `next` runs at once.
 */
export function closeSettingsThen(next: (closed: boolean) => void): void {
  let claimed = false;
  let settled = false;
  const request: SettingsCloseRequest = {
    claim: () => {
      claimed = true;
    },
    settle: (closed) => {
      if (settled) return;
      settled = true;
      next(closed);
    },
  };
  for (const listener of [...listeners]) listener(request);
  if (!claimed) request.settle(true);
}

/** The Settings dialog answers close requests while it is mounted. */
export function onSettingsCloseRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
