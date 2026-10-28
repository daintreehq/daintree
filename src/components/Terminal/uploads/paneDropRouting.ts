import { useCallback, useSyncExternalStore } from "react";
import type { TransferSource } from "@/lib/transferSources";
import type { TerminalFocusTarget } from "../terminalFocus";

/**
 * An agent pane has two surfaces that take dropped files, its terminal and its
 * input bar, and a drop lands where a click at the drop point would have put
 * the keyboard: a drop on the bar goes to the bar, and one on the terminal
 * goes wherever a click on the terminal would send the keyboard, which the
 * pane works out (`getTerminalClickTarget`). The keyboard's current owner only
 * matters as far as it changes what that click would do.
 */
export interface PaneDropTarget {
  /** Could take a file drop right now. */
  canTake: () => boolean;
  /** Takes the drop and returns true, or declines it so the surface it landed on does. */
  take: (sources: readonly TransferSource[]) => boolean;
}

const targets: Record<TerminalFocusTarget, Map<string, PaneDropTarget>> = {
  hybridInput: new Map(),
  xterm: new Map(),
};

export function registerPaneDropTarget(
  terminalId: string,
  surface: TerminalFocusTarget,
  target: PaneDropTarget
): () => void {
  const registry = targets[surface];
  registry.set(terminalId, target);
  return () => {
    if (registry.get(terminalId) === target) registry.delete(terminalId);
  };
}

const otherSurface = (surface: TerminalFocusTarget): TerminalFocusTarget =>
  surface === "xterm" ? "hybridInput" : "xterm";

/** Whether the pane's surface is registered and could take a drop now. */
export function canPaneSurfaceTakeDrop(terminalId: string, surface: TerminalFocusTarget): boolean {
  return targets[surface].get(terminalId)?.canTake() ?? false;
}

/**
 * Which surface of the pane takes a drop let go over `droppedOn`. `onClick` is
 * where a click there would put the keyboard. A surface that can't take the
 * drop passes it to the other one; with neither able to, it stays with the one
 * dropped on, which refuses it.
 */
export function resolvePaneDropTarget(
  terminalId: string,
  droppedOn: TerminalFocusTarget,
  onClick: TerminalFocusTarget = droppedOn
): TerminalFocusTarget {
  if (canPaneSurfaceTakeDrop(terminalId, onClick)) return onClick;
  const fallback = otherSurface(onClick);
  return canPaneSurfaceTakeDrop(terminalId, fallback) ? fallback : droppedOn;
}

/** Hand a drop to one surface of the pane; false when it has none or it declined. */
export function routePaneDrop(
  terminalId: string,
  surface: TerminalFocusTarget,
  sources: readonly TransferSource[]
): boolean {
  return targets[surface].get(terminalId)?.take(sources) ?? false;
}

/**
 * The drag in progress over each pane: the drop zone under the pointer and
 * the surface the drop would land on, or none when it would be refused. Only
 * that surface shows drop feedback, so a drop headed for the input bar never
 * lights the terminal it hovers over.
 *
 * A drop zone clears only a hover it recorded itself, by the owner token it
 * recorded it with: Chromium fires the dragleave of the zone the pointer just
 * left after the dragenter of the next one, and a second mount of the same
 * terminal unmounting mustn't wipe the hover of the one still under the drag.
 */
interface PaneDragHover {
  owner: object;
  target: TerminalFocusTarget | null;
}

const hovers = new Map<string, PaneDragHover>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function notePaneDragOver(
  key: string,
  owner: object,
  target: TerminalFocusTarget | null
): void {
  const current = hovers.get(key);
  if (current?.owner === owner && current.target === target) return;
  hovers.set(key, { owner, target });
  emit();
}

export function clearPaneDragOver(key: string, owner: object): void {
  if (hovers.get(key)?.owner !== owner) return;
  hovers.delete(key);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a drag over the pane would drop on `surface`. */
export function usePaneDropHighlight(key: string, surface: TerminalFocusTarget): boolean {
  const read = useCallback(() => hovers.get(key)?.target === surface, [key, surface]);
  return useSyncExternalStore(subscribe, read, read);
}

/** @internal Tests only. */
export function _resetPaneDropRoutingForTests(): void {
  targets.hybridInput.clear();
  targets.xterm.clear();
  hovers.clear();
  emit();
}
