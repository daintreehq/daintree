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

function agentsWorkingLine(activeAgents: number): string {
  return `${activeAgents} agent${activeAgents > 1 ? "s are" : " is"} currently working`;
}

function attachedShellsMessage(attachedShells: AttachedShell[]): string {
  return `${describeShellNames(attachedShells)} ${attachedShells.length > 1 ? "are" : "is"} attached to this host`;
}

export async function showQuitWarning(
  impact: QuitImpact,
  showMessageBox: Dialog["showMessageBox"],
  win?: BrowserWindow | null
): Promise<boolean> {
  const { activeAgents, attachedShells } = impact;
  const agentsLine = agentsWorkingLine(activeAgents);
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
          message: attachedShellsMessage(attachedShells),
          detail:
            activeAgents > 0
              ? `${shellsLine} ${agentsLine}, and quitting will interrupt them too.`
              : shellsLine,
        };

  const { response } = win ? await showMessageBox(win, opts) : await showMessageBox(opts);

  return response === 0;
}

export async function showUpdateWarning(
  impact: QuitImpact,
  showMessageBox: Dialog["showMessageBox"],
  win?: BrowserWindow | null
): Promise<boolean> {
  const { activeAgents, attachedShells } = impact;
  const agentsLine = agentsWorkingLine(activeAgents);
  const staysReady = "The update stays ready until you restart.";
  const shellsLine = `Restarting to update disconnects ${describeShellNames(attachedShells)} and ends the work it has open on this machine.`;

  const opts: Electron.MessageBoxOptions =
    attachedShells.length === 0
      ? {
          type: "warning",
          buttons: ["Restart and Update", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Agents are working",
          message: agentsLine,
          detail: `Restarting to update now will interrupt active agents. ${staysReady}`,
        }
      : {
          type: "warning",
          buttons: ["Restart and Update", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Other machines are attached",
          message: attachedShellsMessage(attachedShells),
          detail:
            activeAgents > 0
              ? `${shellsLine} ${agentsLine}, and restarting will interrupt them too. ${staysReady}`
              : `${shellsLine} ${staysReady}`,
        };

  const { response } = win ? await showMessageBox(win, opts) : await showMessageBox(opts);

  return response === 0;
}
