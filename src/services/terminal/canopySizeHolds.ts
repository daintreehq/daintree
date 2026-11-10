import { onHostResync } from "@/store/hostResyncSignal";
import { logWarn } from "@/utils/logger";

/**
 * The terminals a Canopy panel holds at its own size, on this machine or
 * another (#14497, #16333). Main is the only authority: this mirrors its list.
 * Their panes follow the PTY's grid instead of fitting.
 */
let held: ReadonlySet<string> = new Set();
// Asked once per list: a hold from another machine stands, and every keystroke
// in its pane would otherwise ask again.
const asked = new Set<string>();
const listeners = new Set<() => void>();
let offPush: (() => void) | null = null;
let offResync: (() => void) | null = null;
// A pull from an earlier read must not land after cleanup or a newer read,
// and a push since the read began outranks it.
let readGeneration = 0;
let pushLandedGeneration = -1;

export function isCanopySizeHeld(terminalId: string): boolean {
  return held.has(terminalId);
}

/**
 * The user typed or clicked in this terminal's pane, which takes the size back
 * from a panel. Main lets go, and the pane fits again on hearing it has.
 */
export function takeCanopySize(terminalId: string): void {
  if (!held.has(terminalId) || asked.has(terminalId)) return;
  const take = window.electron.canopy?.takeTerminalSize;
  if (!take) return;
  asked.add(terminalId);
  take(terminalId).catch((error: unknown) => {
    // Nothing moved, so no new list is coming to clear this: the next keystroke asks.
    asked.delete(terminalId);
    logWarn("[canopySizeHolds] Couldn't take the terminal's size back", { error });
  });
}

function apply(terminalIds: readonly string[]): void {
  held = new Set(terminalIds);
  asked.clear();
  for (const listener of [...listeners]) listener();
}

function hydrate(): void {
  const read = window.electron.canopy?.getSizeHolds;
  if (!read) return;
  const generation = ++readGeneration;
  read()
    .then((terminalIds) => {
      if (generation !== readGeneration || pushLandedGeneration === generation) return;
      apply(terminalIds);
    })
    .catch((error: unknown) => {
      logWarn("[canopySizeHolds] Couldn't read which terminals Canopy holds", { error });
    });
}

/**
 * Subscribe, then hydrate: a hold taken before this view existed, or changed
 * while its link to the host was down, is otherwise not heard of until the
 * next one changes.
 */
function start(): void {
  if (offPush !== null || typeof window === "undefined" || !window.electron?.events) return;
  offPush = window.electron.events.on("terminal:canopy-size-holds-changed", (terminalIds) => {
    pushLandedGeneration = readGeneration;
    apply(terminalIds);
  });
  offResync = onHostResync(hydrate);
  hydrate();
}

function stop(): void {
  readGeneration += 1;
  offPush?.();
  offPush = null;
  offResync?.();
  offResync = null;
  held = new Set();
  asked.clear();
}

export function subscribeCanopySizeHolds(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}
