import type { BrowserWindow } from "electron";
import type { AgentAvailabilityStore } from "../services/AgentAvailabilityStore.js";
import { describeShellNames, type AttachedShell } from "../lifecycle/attachedShells.js";

type Dialog = typeof import("electron").dialog;

const ACTIVE_STATES = new Set(["working"]);

export function getActiveAgentCount(store: AgentAvailabilityStore): number {
  return store.getAgentsByAvailability().filter((a) => ACTIVE_STATES.has(a.state)).length;
}

export interface QuitImpact {
  activeAgents: number;
  attachedShells: AttachedShell[];
}

export async function showQuitWarning(
  impact: QuitImpact,
  showMessageBox: Dialog["showMessageBox"],
  win?: BrowserWindow | null
): Promise<boolean> {
  const { activeAgents, attachedShells } = impact;
  const agentsLine = `${activeAgents} agent${activeAgents > 1 ? "s are" : " is"} currently working`;
  const shellsLine = `Quitting disconnects ${describeShellNames(attachedShells)} and ends the work it has open on this machine.`;

  const opts: Electron.MessageBoxOptions =
    attachedShells.length === 0
      ? {
          type: "warning",
          buttons: ["Quit Anyway", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Agents are working",
          message: agentsLine,
          detail: "Quitting now will interrupt active agents. Any unsaved progress may be lost.",
        }
      : {
          type: "warning",
          buttons: ["Quit Anyway", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Other machines are attached",
          message: `${describeShellNames(attachedShells)} ${attachedShells.length > 1 ? "are" : "is"} attached to this host`,
          detail:
            activeAgents > 0
              ? `${shellsLine} ${agentsLine}, and quitting will interrupt them too.`
              : shellsLine,
        };

  const { response } = win ? await showMessageBox(win, opts) : await showMessageBox(opts);

  return response === 0;
}

export async function showUpdateWarning(
  attachedShells: AttachedShell[],
  showMessageBox: Dialog["showMessageBox"],
  win?: BrowserWindow | null
): Promise<boolean> {
  const names = describeShellNames(attachedShells);
  const opts: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Restart and Update", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Other machines are attached",
    message: `${names} ${attachedShells.length > 1 ? "are" : "is"} attached to this host`,
    detail: `Restarting to update disconnects ${names} and ends the work it has open on this machine. The update stays ready until you restart.`,
  };

  const { response } = win ? await showMessageBox(win, opts) : await showMessageBox(opts);

  return response === 0;
}
