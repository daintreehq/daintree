import type { TerminalInstance, TabGroup } from "@shared/types";

export interface PanelStoreSnapshot {
  panelsById: Record<string, TerminalInstance>;
  panelIds: string[];
  tabGroups: Map<string, TabGroup>;
}

export interface WorktreeSelectionSnapshot {
  activeWorktreeId: string | null;
}

let _getPanelStoreState: (() => PanelStoreSnapshot) | null = null;
let _getWorktreeSelectionState: (() => WorktreeSelectionSnapshot) | null = null;
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
  _clearPanelStoreForSwitch = null;
  _clearFleetArming = null;
  _getFleetArmedIds = null;
  _getFleetLastArmedId = null;
}
