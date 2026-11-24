import type { BrowserWindow } from "electron";
import type { AgentAvailabilityStore } from "../services/AgentAvailabilityStore.js";
import type { AttachedShell } from "../lifecycle/attachedShells.js";
import {
  describeAttachedMachines,
  type AttachedMachinesCopy,
} from "../../shared/utils/attachedMachines.js";
import { PRODUCT_NAME } from "./productBranding.js";

type Dialog = typeof import("electron").dialog;

export interface ActiveAgents {
  /** Agents a quit would cut off mid-step: working, or held on a permission prompt. */
  activeAgents: number;
  /** Of those, the ones waiting on a permission prompt nobody has answered. */
  awaitingApproval: number;
}

/**
 * A permission prompt is a step in flight just as much as a tool call is. A
 * free-form question, an empty prompt or a settled error is not: quitting
 * there cuts nothing off, and the conversation comes back on relaunch.
 */
export function getActiveAgents(store: AgentAvailabilityStore): ActiveAgents {
  let working = 0;
  let awaitingApproval = 0;
  for (const agent of store.getAgentsByAvailability()) {
    if (agent.state === "working") working += 1;
    else if (
      agent.state === "waiting" &&
      store.getTerminalSnapshot(agent.terminalId)?.waitingReason === "approval"
    ) {
      awaitingApproval += 1;
    }
  }
  return { activeAgents: working + awaitingApproval, awaitingApproval };
}

export function getActiveAgentCount(store: AgentAvailabilityStore): number {
  return getActiveAgents(store).activeAgents;
}

export interface QuitImpact extends ActiveAgents {
  attachedShells: AttachedShell[];
}

/** What the user chose in the quit warning. */
export type QuitDecision = "quit" | "keep-running" | "cancel";

export interface QuitWarningOptions {
  /**
   * Offer to close every window and leave the agents running instead. Only
   * while a window is open: with none, Cancel already does that.
   */
  offerKeepRunning?: boolean;
}

function agentsLine({ activeAgents, awaitingApproval }: ActiveAgents): string {
  const working = activeAgents - awaitingApproval;
  const agents = (n: number) => `${n} agent${n > 1 ? "s are" : " is"}`;
  if (awaitingApproval === 0) return `${agents(working)} currently working`;
  if (working === 0) return `${agents(awaitingApproval)} waiting for permission`;
  return `${agents(working)} working and ${awaitingApproval} ${awaitingApproval > 1 ? "are" : "is"} waiting for permission`;
}

function attachedMachines(attachedShells: AttachedShell[]): AttachedMachinesCopy {
  return describeAttachedMachines(attachedShells.map((s) => s.clientName));
}

function attachedMachinesMessage(machines: AttachedMachinesCopy): string {
  return `${machines.subject} ${machines.verb} attached to this host`;
}

const KEEP_RUNNING_DECISIONS: readonly QuitDecision[] = ["keep-running", "quit", "cancel"];

export async function showQuitWarning(
  impact: QuitImpact,
  showMessageBox: Dialog["showMessageBox"],
  win?: BrowserWindow | null,
  { offerKeepRunning = false }: QuitWarningOptions = {}
): Promise<QuitDecision> {
  const { activeAgents, attachedShells } = impact;
  const agentsWorking = agentsLine(impact);
  const machines = attachedMachines(attachedShells);
  const shellsLine = `Quitting disconnects ${machines.object} and ends ${machines.openWork} on this machine.`;
  const keepRunning = offerKeepRunning && activeAgents > 0;

  let detail: string;
  if (attachedShells.length === 0) {
    detail = keepRunning
      ? `Keep Agents Running closes every window and leaves these agents running in the background; open ${PRODUCT_NAME} again to get back to them. Quitting stops them, and any unsaved progress may be lost.`
      : "Quitting now will interrupt active agents. Any unsaved progress may be lost.";
  } else {
    detail =
      activeAgents > 0
        ? `${shellsLine} ${agentsWorking}, and quitting will interrupt them too.`
        : shellsLine;
    if (keepRunning) {
      detail += ` Keep Agents Running closes every window instead, and these agents keep running with ${machines.object} still attached.`;
    }
  }

  const opts: Electron.MessageBoxOptions = {
    type: "warning",
    // Off macOS, labels that aren't stock ones become command links without noLink.
    ...(keepRunning
      ? { buttons: ["Keep Agents Running", "Quit and Stop Agents", "Cancel"], noLink: true }
      : { buttons: ["Quit Anyway", "Cancel"] }),
    defaultId: keepRunning ? 2 : 1,
    cancelId: keepRunning ? 2 : 1,
    title: attachedShells.length === 0 ? "Agents are working" : "Other machines are attached",
    message: attachedShells.length === 0 ? agentsWorking : attachedMachinesMessage(machines),
    detail,
  };

  const { response } = win ? await showMessageBox(win, opts) : await showMessageBox(opts);

  if (keepRunning) return KEEP_RUNNING_DECISIONS[response] ?? "cancel";
  return response === 0 ? "quit" : "cancel";
}

export async function showUpdateWarning(
  impact: QuitImpact,
  showMessageBox: Dialog["showMessageBox"],
  win?: BrowserWindow | null
): Promise<boolean> {
  const { activeAgents, attachedShells } = impact;
  const agentsWorking = agentsLine(impact);
  const staysReady = "The update stays ready until you restart.";
  const machines = attachedMachines(attachedShells);
  const shellsLine = `Restarting to update disconnects ${machines.object} and ends ${machines.openWork} on this machine.`;

  const opts: Electron.MessageBoxOptions =
    attachedShells.length === 0
      ? {
          type: "warning",
          buttons: ["Restart and Update", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Agents are working",
          message: agentsWorking,
          detail: `Restarting to update now will interrupt active agents. ${staysReady}`,
        }
      : {
          type: "warning",
          buttons: ["Restart and Update", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Other machines are attached",
          message: attachedMachinesMessage(machines),
          detail:
            activeAgents > 0
              ? `${shellsLine} ${agentsWorking}, and restarting will interrupt them too. ${staysReady}`
              : `${shellsLine} ${staysReady}`,
        };

  const { response } = win ? await showMessageBox(win, opts) : await showMessageBox(opts);

  return response === 0;
}
