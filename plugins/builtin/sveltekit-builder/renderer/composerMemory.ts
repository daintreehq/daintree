import { useSyncExternalStore } from "react";
import type { DeliveryState } from "@/services/agentRequests";
import type { SiteSelection } from "../shared/model.js";
import type { ComponentDefinitions, PickedComponent, SourceRevisions } from "./agentTask.js";

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
  /** The host's id for this request: what a row is keyed, pushed on and removed by. */
  id: string;
  /** The user's own words, which a row shows before — and beside — the full request. */
  instruction: string;
  /** What it was about when it was sent, so it can be sent again; null when that isn't known. */
  subject: ComposerPin | null;
  state: DeliveryState;
  title: string;
  terminalId: string | null;
  /**
   * The exact text typed into the agent, once built: what the agent was told is
   * what the user reviews, not a reconstruction. Lives as long as the record.
   */
  request?: string;
}

export interface ComposerMemory {
  draft: string;
  pinned: ComposerPin | null;
  /** The destination the user committed to, by key; null until they write. */
  chosen: string | null;
  /**
   * Every request this composer has made and not dismissed, oldest first:
   * waiting, going in, and gone. A request sent while the agent is busy joins
   * the end and goes in when its turn comes.
   */
  deliveries: ComposerDelivery[];
}

/** How many settled requests a composer keeps on show before the oldest drop off. */
const KEPT_DELIVERIES = 8;

const SETTLED = new Set<DeliveryState["status"]>(["sent", "unconfirmed", "failed"]);

export function isSettledDelivery(delivery: ComposerDelivery): boolean {
  return SETTLED.has(delivery.state.status);
}

/**
 * Part of this request may be sitting in the agent's input. Its record is what
 * holds sending off until the user has answered it, so it is never dropped to
 * make room: only Dismiss or sending it again takes it away.
 */
export function isUncertainDelivery(delivery: ComposerDelivery): boolean {
  return (
    delivery.state.status === "unconfirmed" ||
    (delivery.state.status === "failed" && delivery.state.partial === true)
  );
}

/** Add or replace one request's record, by id, keeping the order they were made in. */
export function putComposerDelivery(memoryKey: string, delivery: ComposerDelivery): void {
  const before = readComposerMemory(memoryKey).deliveries;
  const at = before.findIndex((entry) => entry.id === delivery.id);
  let next = at < 0 ? [...before, delivery] : before.map((e, i) => (i === at ? delivery : e));
  // Only what has settled and needs nothing from the user is ever dropped: a
  // waiting request is a promise, and an uncertain one is a guard.
  const droppable = (entry: ComposerDelivery) =>
    isSettledDelivery(entry) && !isUncertainDelivery(entry) && entry.id !== delivery.id;
  let excess = next.filter(droppable).length - KEPT_DELIVERIES;
  if (excess > 0) next = next.filter((entry) => !(droppable(entry) && excess-- > 0));
  updateComposerMemory(memoryKey, { deliveries: next });
}

export function removeComposerDelivery(memoryKey: string, id: string): void {
  const before = readComposerMemory(memoryKey).deliveries;
  const next = before.filter((entry) => entry.id !== id);
  if (next.length !== before.length) updateComposerMemory(memoryKey, { deliveries: next });
}

const EMPTY: ComposerMemory = {
  draft: "",
  pinned: null,
  chosen: null,
  deliveries: [],
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
