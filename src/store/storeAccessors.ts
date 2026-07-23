import type { TabGroup } from "@shared/types";
import { getNarrowPanel } from "./slices/panelRegistry/selectors";

// Carrier element from the legacy `panelsById` shape, sourced through
// `getNarrowPanel`'s parameter so this file doesn't import the deprecated
// `TerminalInstance` alias by name. The carrier itself flips to
// `PanelInstance` in #8957 step 5; this alias auto-resolves through.
type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

export interface PanelStoreSnapshot {
  panelsById: Record<string, CarrierPanel>;
  panelIds: string[];
  tabGroups: Map<string, TabGroup>;
}

export interface WorktreeSelectionSnapshot {
  activeWorktreeId: string | null;
  /** Durable selection that should round-trip across project switches (#9512). */
  restoreWorktreeId: string | null;
}

let _getPanelStoreState: (() => PanelStoreSnapshot) | null = null;
let _getWorktreeSelectionState: (() => WorktreeSelectionSnapshot) | null = null;
let _getWorktreeIdSet: (() => Set<string> | null) | null = null;
let _getWorktreeGitDirById: ((worktreeId: string) => string | undefined) | null = null;
let _clearPanelStoreForSwitch: (() => void) | null = null;
let _clearFleetArming: (() => void) | null = null;
let _getFleetArmedIds: (() => Set<string>) | null = null;
let _getFleetLastArmedId: (() => string | null) | null = null;

export function setPanelStoreAccessor(getter: () => PanelStoreSnapshot): void {
  _getPanelStoreState = getter;
}

export function getPanelStoreSnapshot(): PanelStoreSnapshot | null {
  return _getPanelStoreState?.() ?? null;
}

export function setWorktreeSelectionAccessor(getter: () => WorktreeSelectionSnapshot): void {
  _getWorktreeSelectionState = getter;
}

export function getWorktreeSelectionSnapshot(): WorktreeSelectionSnapshot | null {
  return _getWorktreeSelectionState?.() ?? null;
}

export function setWorktreeIdSetAccessor(getter: () => Set<string> | null): void {
  _getWorktreeIdSet = getter;
}

/**
 * The set of worktree IDs known to the current project view, or `null` when no
 * view store is mounted (validation should be skipped). Lets the outgoing-state
 * builder drop a stale restore target that no longer exists (#9512).
 */
export function getWorktreeIdSet(): Set<string> | null {
  return _getWorktreeIdSet?.() ?? null;
}

export function setWorktreeGitDirAccessor(
  getter: (worktreeId: string) => string | undefined
): void {
  _getWorktreeGitDirById = getter;
}

/**
 * The stable `.git/worktrees/<name>` handle for a worktree in the current view,
 * or `undefined` when unknown / no view store is mounted. Persisted with each
 * panel so restore can survive a worktree path change (#11388).
 */
export function getWorktreeGitDirById(worktreeId: string): string | undefined {
  return _getWorktreeGitDirById?.(worktreeId);
}

export function setPanelStoreClearForSwitchAccessor(callback: () => void): void {
  _clearPanelStoreForSwitch = callback;
}

export function clearPanelStoreForSwitchThroughAccessor(): void {
  _clearPanelStoreForSwitch?.();
}

export function setFleetArmingClearAccessor(callback: () => void): void {
  _clearFleetArming = callback;
}

export function clearFleetArmingThroughAccessor(): void {
  _clearFleetArming?.();
}

export function setFleetArmedIdsAccessor(getter: () => Set<string>): void {
  _getFleetArmedIds = getter;
}

export function getFleetArmedIds(): Set<string> | null {
  return _getFleetArmedIds?.() ?? null;
}

export function setFleetLastArmedIdAccessor(getter: () => string | null): void {
  _getFleetLastArmedId = getter;
}

export function getFleetLastArmedId(): string | null {
  return _getFleetLastArmedId?.() ?? null;
}

export function resetStoreAccessorsForTesting(): void {
  _getPanelStoreState = null;
  _getWorktreeSelectionState = null;
  _getWorktreeIdSet = null;
  _getWorktreeGitDirById = null;
  _clearPanelStoreForSwitch = null;
  _clearFleetArming = null;
  _getFleetArmedIds = null;
  _getFleetLastArmedId = null;
}
