import type { PowerPolicyLevel, PowerPolicySnapshot } from "@shared/types/powerPolicy";

/**
 * This view's copy of main's power policy (`system:power-policy-changed`).
 *
 * The only renderer subscriber to that push, deliberately: preload replays a
 * push that arrived before anyone subscribed to the first subscriber alone, so
 * a second subscriber would never learn the policy its view was loaded into.
 * Everything in the renderer that reads the policy reads it here.
 *
 * `screenLocked` is the renderer's only sight of a locked screen. Locking fires
 * no window blur, so `document.hasFocus()` keeps answering true and any "is
 * anyone looking" gate written against focus alone says yes. Lock events fire
 * on macOS and Windows only; elsewhere this stays unlocked and focus decides
 * alone, as it always has.
 *
 * One view per V8 context, so module state is this view's state (see
 * `viewCacheState`).
 */

let level: PowerPolicyLevel = "active";
let screenLocked = false;
let armed = false;
let disarm: (() => void) | undefined;
const levelListeners = new Set<(level: PowerPolicyLevel) => void>();
const screenLockListeners = new Set<(locked: boolean) => void>();

function emit<T>(listeners: Set<(value: T) => void>, value: T): void {
  // Snapshot: a listener may unsubscribe during iteration.
  for (const listener of Array.from(listeners)) {
    try {
      listener(value);
    } catch (error) {
      console.error("[powerPolicyState] listener threw:", error);
    }
  }
}

function apply(snapshot: PowerPolicySnapshot): void {
  const nextLevel = snapshot.level;
  const nextLocked = snapshot.screenLocked === true;
  const levelChanged = nextLevel !== level;
  const lockChanged = nextLocked !== screenLocked;
  level = nextLevel;
  screenLocked = nextLocked;
  // Both fields settle before anyone hears, so a listener reading the other
  // one never sees half a push.
  if (levelChanged) emit(levelListeners, level);
  if (lockChanged) emit(screenLockListeners, screenLocked);
}

/**
 * Subscribe on first use, from a read as well as a subscribe, so a read-only
 * caller like `notify()` can't be left reading the boot default forever. The
 * subscription lives as long as the view and nothing but the test reset undoes
 * it (#10456); a renderer with no bridge yet stays free to arm later.
 */
function ensureArmed(): void {
  if (armed) return;
  // Undeclared, not just empty, in node-like suites that reach this through
  // notify().
  if (typeof window === "undefined") return;
  const events = window.electron?.events;
  if (!events) return;
  // Latched before subscribing because preload replays a buffered push
  // synchronously inside `on`, and a listener reading state during that replay
  // must not subscribe a second time. A throw unlatches it again.
  armed = true;
  try {
    disarm = events.on("system:power-policy-changed", apply);
  } catch {
    armed = false;
  }
}

export function getPowerPolicyLevel(): PowerPolicyLevel {
  ensureArmed();
  return level;
}

/** Whether main has seen the screen lock. Always false where lock events never fire. */
export function isScreenLocked(): boolean {
  ensureArmed();
  return screenLocked;
}

/** Fires on level changes only, after the new level is readable. */
export function subscribePowerPolicyLevel(listener: (level: PowerPolicyLevel) => void): () => void {
  ensureArmed();
  levelListeners.add(listener);
  return () => {
    levelListeners.delete(listener);
  };
}

/** Fires on lock and unlock edges only, after {@link isScreenLocked} answers the new state. */
export function subscribeScreenLock(listener: (locked: boolean) => void): () => void {
  ensureArmed();
  screenLockListeners.add(listener);
  return () => {
    screenLockListeners.delete(listener);
  };
}

export function __resetPowerPolicyStateForTests(): void {
  disarm?.();
  disarm = undefined;
  armed = false;
  level = "active";
  screenLocked = false;
  levelListeners.clear();
  screenLockListeners.clear();
}
