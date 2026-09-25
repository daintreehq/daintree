import type { ActionId } from "@shared/types/actions";
import type { ChecklistItemId } from "@shared/types/ipc/maps";

export interface ChecklistItemDef {
  id: ChecklistItemId;
  label: string;
  description?: string;
  actionId: ActionId;
  actionArgs?: unknown;
  markOnClick?: boolean;
}

export const CHECKLIST_ITEMS: ChecklistItemDef[] = [
  {
    id: "openedProject",
    label: "Open your project",
    description: "Connect a local folder — everything else flows from here",
    actionId: "project.add",
  },
  {
    id: "launchedAgent",
    label: "Launch your first agent",
    description: "Then ask it to fix a bug, write a feature, or explain your code",
    actionId: "panel.palette",
  },
  {
    id: "createdWorktree",
    label: "Start a parallel task",
    description: "Work on two things at once without switching branches",
    actionId: "worktree.createDialog.open",
  },
  {
    id: "ranSecondParallelAgent",
    label: "Run two agents in parallel",
    description:
      "Kick off a second agent while the first keeps working — that's the Daintree superpower",
    actionId: "panel.palette",
  },
];
