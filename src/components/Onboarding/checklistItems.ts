import type { ComponentType } from "react";
import { FolderOpen } from "lucide-react";
import { CanopyAgentIcon, WorktreeIcon } from "@/components/icons";
import type { ActionId } from "@shared/types/actions";
import type { ChecklistItemId } from "@shared/types/ipc/maps";

export interface ChecklistItemDef {
  id: ChecklistItemId;
  label: string;
  icon: ComponentType<{ className?: string }>;
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
    icon: CanopyAgentIcon,
    actionId: "panel.palette",
  },
  {
    id: "createdWorktree",
    label: "Create a worktree",
    icon: WorktreeIcon,
    actionId: "worktree.createDialog.open",
  },
];
