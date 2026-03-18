import { FolderOpen, Bot, GitBranch } from "lucide-react";
import type { ActionId } from "@shared/types/actions";
import type { ChecklistItemId } from "@shared/types/ipc/maps";

export interface ChecklistItemDef {
  id: ChecklistItemId;
  label: string;
  icon: typeof FolderOpen;
  actionId: ActionId;
}

export const CHECKLIST_ITEMS: ChecklistItemDef[] = [
  {
    id: "openedProject",
    label: "Open a project",
    icon: FolderOpen,
    actionId: "project.openDialog",
  },
  {
    id: "launchedAgent",
    label: "Launch an AI agent",
    icon: Bot,
    actionId: "panel.palette",
  },
  {
    id: "createdWorktree",
    label: "Create a worktree",
    icon: GitBranch,
    actionId: "worktree.createDialog.open",
  },
];
