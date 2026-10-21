// eager-import-allow: the issue map is an electron-store key, read and written synchronously
import { store } from "../store.js";
import type { IssueAssociation } from "../../shared/types/ipc/worktree.js";

/** Record (or replace) a worktree's explicit issue link. */
export function persistIssueAssociation(worktreeId: string, association: IssueAssociation): void {
  const currentMap = store.get("worktreeIssueMap") ?? {};
  store.set("worktreeIssueMap", { ...currentMap, [worktreeId]: association });
}
