import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";
import { isProjectViewObservable } from "@/lib/viewCacheState";

/**
 * Where a copy was asked for, snapshotted when the gesture starts. The menu
 * that asked has closed by the time the clipboard settles, and its row may
 * have unmounted, so the flash anchors to coordinates rather than a node.
 */
export type CopyOrigin =
  | { kind: "point"; x: number; y: number }
  | { kind: "rect"; left: number; top: number; right: number; bottom: number };

export interface CopyFlash {
  id: number;
  /** `null` places the flash bottom-centre. */
  origin: CopyOrigin | null;
}

/** A capture snapshot: the origin plus the view lifecycle it was taken in. */
export interface CopyFlashTicket {
  origin: CopyOrigin | null;
  generation: number;
}

let current: CopyFlash | null = null;
let nextId = 1;
// Bumped whenever the view stops being observable, so a write that settles
// after a project switch can still be announced but never draws.
let generation = 0;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let lastInput: "pointer" | "keyboard" | null = null;
let lastPointer: { x: number; y: number } | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function clearTimer(): void {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

export function subscribeCopyFlash(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCopyFlash(): CopyFlash | null {
  return current;
}

/** Fed by the host's capture-phase listeners. */
export function noteCopyFlashPointer(x: number, y: number): void {
  lastInput = "pointer";
  lastPointer = { x, y };
}

export function noteCopyFlashKeyboard(): void {
  lastInput = "keyboard";
}

/**
 * Snapshot where the user is acting. Called synchronously inside the gesture:
 * a keyboard select still has focus on the menu item it chose, which is about
 * to unmount, so its rect has to be read now.
 */
export function captureCopyFlash(): CopyFlashTicket {
  let origin: CopyOrigin | null = null;
  if (lastInput === "pointer" && lastPointer) {
    origin = { kind: "point", ...lastPointer };
  } else if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      const rect = active.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        origin = {
          kind: "rect",
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };
      }
    }
  }
  return { origin, generation };
}

/**
 * Show "Copied" near the ticket's origin, replacing any flash already up. A
 * ticket from an earlier view lifecycle, or a view nobody can see, draws
 * nothing — the confirmation belongs to the moment it was asked for.
 */
export function showCopyFlash(ticket: CopyFlashTicket): void {
  if (ticket.generation !== generation || !isProjectViewObservable()) return;
  clearTimer();
  current = { id: nextId++, origin: ticket.origin };
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    current = null;
    emit();
  }, UI_ACTION_SUCCESS_DWELL_MS);
  emit();
}

export function dismissCopyFlash(): void {
  clearTimer();
  if (current === null) return;
  current = null;
  emit();
}

/** The view went out of sight: drop the flash and void every pending ticket. */
export function invalidateCopyFlash(): void {
  generation++;
  lastInput = null;
  lastPointer = null;
  dismissCopyFlash();
}

export function _resetCopyFlashForTests(): void {
  clearTimer();
  current = null;
  nextId = 1;
  generation = 0;
  lastInput = null;
  lastPointer = null;
  listeners.clear();
}
