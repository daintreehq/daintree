import { useSyncExternalStore } from "react";
import type { SiteSelection } from "../shared/model.js";
import type {
  ComponentDefinitions,
  DeliveryState,
  PickedComponent,
  SourceRevisions,
} from "./agentTask.js";

export interface ComposerPin {
  selection: SiteSelection;
  file: string | null;
  /** Index into the scopes for this selection: the element, or a component around it. */
  scope: number;
  /** The component picked on the page, when the selection was one. */
  picked: PickedComponent | null;
  /** Where the selection's components are written, as main last reported it. */
  definitions: ComponentDefinitions;
  /** Revisions of the files the request may cite, arriving with `definitions`. */
  revisions: SourceRevisions;
}

export interface ComposerDelivery {
  state: DeliveryState;
  title: string;
  terminalId: string | null;
}

export interface ComposerMemory {
  draft: string;
  pinned: ComposerPin | null;
  /** The destination the user committed to, by key; null until they write. */
  chosen: string | null;
  delivery: ComposerDelivery | null;
  /**
   * The notice about the last delivery has been closed, without deciding that a
   * half-delivered request is safe to repeat. Kept apart from `delivery` because
   * the partial-send guard reads that record: clearing it to hide the notice
   * would rearm the send it exists to block.
   */
  deliveryDismissed?: boolean;
}

const EMPTY: ComposerMemory = {
  draft: "",
  pinned: null,
  chosen: null,
  delivery: null,
  deliveryDismissed: false,
};
const memories = new Map<string, ComposerMemory>();
const listeners = new Set<() => void>();

/**
 * The composer's state for one preview, kept outside React. The drawer closes
 * when the selection is cleared and remounts whenever the grid re-lays the
 * preview — starting an agent does exactly that — and neither may lose a
 * half-written request or cut a delivery off mid-flight.
 */
export function readComposerMemory(previewPanelId: string): ComposerMemory {
  return memories.get(previewPanelId) ?? EMPTY;
}

export function updateComposerMemory(previewPanelId: string, patch: Partial<ComposerMemory>): void {
  memories.set(previewPanelId, { ...readComposerMemory(previewPanelId), ...patch });
  for (const listener of [...listeners]) listener();
}

/**
 * One composer per preview *and* worktree: a preview moved to another worktree
 * keeps its panel id, and a request pinned to one worktree's source must never
 * be sent from the other.
 */
export function composerMemoryKey(previewPanelId: string, worktreeId: string | null): string {
  return `${previewPanelId}\n${worktreeId ?? ""}`;
}

/** Everything held for a preview, in every worktree it has been in. */
export function forgetComposerMemories(previewPanelId: string): void {
  let removed = false;
  for (const key of [...memories.keys()]) {
    if (key.startsWith(`${previewPanelId}\n`)) {
      memories.delete(key);
      removed = true;
    }
  }
  if (collapsedDrawers.delete(previewPanelId)) removed = true;
  if (removed) for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useComposerMemory(previewPanelId: string): ComposerMemory {
  return useSyncExternalStore(subscribe, () => readComposerMemory(previewPanelId));
}

export function __resetComposerMemoryForTests(): void {
  memories.clear();
  collapsedDrawers.clear();
}

const collapsedDrawers = new Set<string>();

/** Whether the user folded the builder's drawer away for this preview. */
export function useDrawerCollapsed(previewPanelId: string): boolean {
  return useSyncExternalStore(subscribe, () => collapsedDrawers.has(previewPanelId));
}

export function setDrawerCollapsed(previewPanelId: string, collapsed: boolean): void {
  if (collapsed === collapsedDrawers.has(previewPanelId)) return;
  if (collapsed) collapsedDrawers.add(previewPanelId);
  else collapsedDrawers.delete(previewPanelId);
  for (const listener of [...listeners]) listener();
}
