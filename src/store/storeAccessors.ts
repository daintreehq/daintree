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
  /**
   * Worktrees that are gone but still hold surviving panels on a sidebar row
   * (#11232). Exposed because these ids are destinations nothing should be
   * moved TO: the row's cleanup sweep trashes whatever it holds, so a panel
   * relocated onto one is scheduled for death (#11911).
   *
   * Optional so a harness that only cares about selection can keep supplying
   * the two ids. Absent reads as "no rows", which is the pre-#11911 behavior.
   */
  deletedWorktreeIds?: ReadonlySet<string>;
}

let _getPanelStoreState: (() => PanelStoreSnapshot) | null = null;
let _getWorktreeSelectionState: (() => WorktreeSelectionSnapshot) | null = null;
let _getWorktreeIdSet: (() => Set<string> | null) | null = null;
let _getWorktreeGitDirById: ((worktreeId: string) => string | undefined) | null = null;
let _getWorktreePathIndex: (() => ReadonlyMap<string, string> | null) | null = null;
let _getProjectPathIndex: (() => ReadonlyMap<string, string> | null) | null = null;
let _setPanelExtensionState: ((panelId: string, patch: Record<string, unknown>) => boolean) | null =
  null;
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

export function setWorktreePathIndexAccessor(
  getter: () => ReadonlyMap<string, string> | null
): void {
  _getWorktreePathIndex = getter;
}

/**
 * Worktree id → absolute worktree path for the current project view, or `null`
 * when no view store is mounted. Backs the shared location-argument resolver
 * (#11543) so an action can accept either `worktreeId` or `worktreePath` and
 * hand its IPC whichever half that call actually needs.
 */
export function getWorktreePathIndex(): ReadonlyMap<string, string> | null {
  return _getWorktreePathIndex?.() ?? null;
}

export function setProjectPathIndexAccessor(
  getter: () => ReadonlyMap<string, string> | null
): void {
  _getProjectPathIndex = getter;
}

/**
 * Project id → absolute project path, or `null` when the project store has not
 * loaded. Lets the shared location resolver turn an explicit `projectId` into
 * the path a project-scoped IPC needs, so naming a NON-active project actually
 * targets it instead of silently falling back to the active one (#11543).
 */
export function getProjectPathIndex(): ReadonlyMap<string, string> | null {
  return _getProjectPathIndex?.() ?? null;
}

/**
 * Lets a plugin panel's view persist state onto its panel record without the
 * plugin view host importing the panel store.
 *
 * The indirection is not ceremony: `PluginViewHost` is imported by a component
 * test that stubs the panel graph, and a static store import there drags the
 * client and service modules in behind it. Routing through the accessor keeps
 * the host a leaf, which is the same reason every other cross-store read in the
 * renderer goes through this module.
 */
export function setPanelExtensionStateAccessor(
  setter: (panelId: string, patch: Record<string, unknown>) => boolean
): void {
  _setPanelExtensionState = setter;
}

/**
 * Returns whether the state is now what the caller asked for. `false` before
 * the orchestrator has registered the setter, which is the honest answer: no
 * store exists yet to have accepted it.
 */
export function persistPanelExtensionStateThroughAccessor(
  panelId: string,
  patch: Record<string, unknown>
): boolean {
  return _setPanelExtensionState?.(panelId, patch) ?? false;
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
  _getWorktreePathIndex = null;
  _getProjectPathIndex = null;
  _setPanelExtensionState = null;
  _clearPanelStoreForSwitch = null;
  _clearFleetArming = null;
  _getFleetArmedIds = null;
  _getFleetLastArmedId = null;
}
