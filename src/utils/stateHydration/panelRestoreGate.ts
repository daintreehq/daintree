/**
 * Whether this view's panels are back since its latest restore began (#18176),
 * so a missing id can be read as missing. A view that just took over an
 * assistant is up before its panels are, and an id it hasn't restored yet is
 * not one the close would miss for long.
 *
 * Each restore takes a token and settles only its own, so an older restore
 * finishing late never reports a newer one done. Nothing has been restored
 * until the first one settles.
 */
let latestRestore = 0;
let settledRestore = -1;

export function beginPanelRestore(): number {
  latestRestore += 1;
  return latestRestore;
}

export function settlePanelRestore(token: number): void {
  if (token === latestRestore) settledRestore = token;
}

export function arePanelsRestored(): boolean {
  return settledRestore === latestRestore;
}
