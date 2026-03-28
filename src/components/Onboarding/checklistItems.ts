import type { ComponentType } from "react";
import { FolderOpen } from "lucide-react";
import { CanopyAgentIcon, WorktreeIcon } from "@/components/icons";
import type { ActionId } from "@shared/types/actions";
import type { ChecklistItemId } from "@shared/types/ipc/maps";

export interface ChecklistItemDef {
  id: ChecklistItemId;
  label: string;
  description?: string;
  icon: ComponentType<{ className?: string }>;
  actionId: ActionId;
}

export const CHECKLIST_ITEMS: ChecklistItemDef[] = [
  {
    id: "openedProject",
    label: "Open your project",
    description: "Connect a local folder — everything else flows from here.",
    icon: FolderOpen,
    actionId: "project.openDialog",
  },
  {
    id: "launchedAgent",
    label: "Ask AI to help with your code",
    description: "Agents can write code, fix bugs, and answer questions about your codebase.",
    icon: CanopyAgentIcon,
    actionId: "panel.palette",
  },
  {
    id: "createdWorktree",
    label: "Start a parallel task",
    description: "Work on two things at once without switching branches.",
    icon: WorktreeIcon,
    actionId: "worktree.createDialog.open",
  },
];
