import type { ProjectState, PanelSnapshot } from "../../shared/types/project.js";
import type { TabGroup } from "../../shared/types/panel.js";
import { rebaseAbsolutePath, rebaseMruEntry } from "../../shared/utils/projectPathRelocation.js";

/**
 * Rewrite the absolute-path-bearing fields of a persisted {@link ProjectState}
 * after a project folder move/rename (#11282, phase 2).
 *
 * Only fields whose values are genuine absolute filesystem paths are rebased:
 * PTY `cwd`, file-panel `filePath`/`markdownFilePath`, `worktreeId` (a worktree
 * id is a normalized absolute path), the `worktreeGitDir` handle (#11388),
 * `activeWorktreeId`, tab-group worktree bindings, and `worktree:` MRU entries.
 * Deliberately excluded — they are not
 * absolute filesystem bindings and blanket substitution would corrupt them:
 *   - `browserRootPath` / `browserSelectedPath` / `browserExpandedPaths` are
 *     worktree-RELATIVE and move with the folder untouched.
 *   - `browserUrl` / `devServerUrl` / `browserHistory` are URLs.
 *   - `command` / `env` / `extensionState` are opaque user/plugin data.
 *   - panel/terminal/tab/layout ids, terminal sizes, drafts and focus state.
 *
 * Returns the SAME object reference when nothing changed so callers can skip the
 * disk write; clones only the arrays/objects that actually change.
 */
export function rewriteProjectStatePaths(
  state: ProjectState,
  oldRoot: string,
  newRoot: string
): ProjectState {
  let changed = false;

  const nextActive =
    state.activeWorktreeId !== undefined
      ? rebaseAbsolutePath(state.activeWorktreeId, oldRoot, newRoot)
      : state.activeWorktreeId;
  if (nextActive !== state.activeWorktreeId) changed = true;

  let terminals = state.terminals;
  if (Array.isArray(state.terminals)) {
    let terminalsChanged = false;
    const rewritten = state.terminals.map((panel) => {
      const next = rewritePanelPaths(panel, oldRoot, newRoot);
      if (next !== panel) terminalsChanged = true;
      return next;
    });
    if (terminalsChanged) {
      terminals = rewritten;
      changed = true;
    }
  }

  let tabGroups = state.tabGroups;
  if (Array.isArray(state.tabGroups)) {
    let tabGroupsChanged = false;
    const rewritten = state.tabGroups.map((group) => {
      const next = rewriteTabGroupPaths(group, oldRoot, newRoot);
      if (next !== group) tabGroupsChanged = true;
      return next;
    });
    if (tabGroupsChanged) {
      tabGroups = rewritten;
      changed = true;
    }
  }

  let mruList = state.mruList;
  if (Array.isArray(state.mruList)) {
    let mruChanged = false;
    const rewritten = state.mruList.map((entry) => {
      const next = rebaseMruEntry(entry, oldRoot, newRoot);
      if (next !== entry) mruChanged = true;
      return next;
    });
    if (mruChanged) {
      mruList = rewritten;
      changed = true;
    }
  }

  if (!changed) return state;
  return {
    ...state,
    activeWorktreeId: nextActive,
    terminals,
    ...(state.tabGroups !== undefined ? { tabGroups } : {}),
    ...(state.mruList !== undefined ? { mruList } : {}),
  };
}

function rewritePanelPaths(panel: PanelSnapshot, oldRoot: string, newRoot: string): PanelSnapshot {
  const patch: Partial<PanelSnapshot> = {};
  let changed = false;

  const rebaseField = (
    key: "cwd" | "worktreeId" | "worktreeGitDir" | "filePath" | "markdownFilePath"
  ): void => {
    const value = panel[key];
    if (value === undefined) return;
    const next = rebaseAbsolutePath(value, oldRoot, newRoot);
    if (next !== value) {
      patch[key] = next;
      changed = true;
    }
  };

  rebaseField("cwd");
  rebaseField("worktreeId");
  // The gitDir handle (#11388) is an absolute path under the repo root, so a
  // project move must rebase it too or the next worktree move can't correlate.
  rebaseField("worktreeGitDir");
  rebaseField("filePath");
  rebaseField("markdownFilePath");

  return changed ? { ...panel, ...patch } : panel;
}

function rewriteTabGroupPaths(group: TabGroup, oldRoot: string, newRoot: string): TabGroup {
  if (group.worktreeId === undefined) return group;
  const next = rebaseAbsolutePath(group.worktreeId, oldRoot, newRoot);
  return next === group.worktreeId ? group : { ...group, worktreeId: next };
}
