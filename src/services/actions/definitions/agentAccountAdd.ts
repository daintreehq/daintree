import { getAgentConfigFolderAccount, getAgentDisplayTitle } from "@shared/config/agentRegistry";
import type { AddAgentAccountRequest } from "@shared/types/ipc/agentAccounts";
import {
  accountFolderName,
  isUsableAccountFolder,
  sanitizeAccountName,
} from "@shared/utils/agentAccounts";
import type { McpConfirmSelectableTarget } from "@/store/mcpConfirmStore";
import { AgentAddAccountArgsSchema } from "./agentActionArgs";

/**
 * `agent.addAccount`'s rows (#17079), planned once for the dialog and again
 * by the run from the same arguments, so the folder a row shows is the folder
 * that row asks main for. Main still makes or checks the folder itself.
 */
export interface PlannedAccountRow {
  /** The row's position in the request. */
  index: number;
  agentId: string;
  agentTitle: string;
  /** The name as main saves it. */
  name: string;
  folder: AddAgentAccountRequest["folder"];
  /** What the dialog shows: `~/` and the folder made, or the existing path as given. */
  destination: string;
}

export type AccountAddPlan =
  { ok: true; rows: PlannedAccountRow[] } | { ok: false; message: string };

/** The checkbox id of a row; the run adds only the rows whose id the dialog kept. */
export function accountRowId(index: number): string {
  return `row-${index}`;
}

function refuse(message: string): AccountAddPlan {
  return { ok: false, message: `${message} Nothing was added.` };
}

export function planAgentAccountAdd(args: unknown): AccountAddPlan {
  const parsed = AgentAddAccountArgsSchema.safeParse(args);
  if (!parsed.success) return refuse("Invalid accounts.");
  const rows: PlannedAccountRow[] = [];
  // One request never asks for the same folder twice: the second would fail
  // after the first was made, or name one folder as two accounts.
  const claimed = new Map<string, number>();
  for (const [index, request] of parsed.data.accounts.entries()) {
    const label = `Account ${index + 1}`;
    const declaration = getAgentConfigFolderAccount(request.agentId);
    if (!declaration) {
      return refuse(`${label}: ${request.agentId} has no accounts to add.`);
    }
    const name = sanitizeAccountName(request.name);
    if (!name) return refuse(`${label}: give it a name.`);
    let folder: AddAgentAccountRequest["folder"];
    let destination: string;
    let key: string;
    if (request.folder.kind === "create") {
      const folderName = accountFolderName(declaration.defaultDir, name);
      if (!folderName) return refuse(`${label}: give it a name with letters or numbers in it.`);
      folder = { kind: "create" };
      destination = `~/${folderName}`;
      key = `create:${folderName}`;
    } else {
      const path = request.folder.path.trim();
      if (!isUsableAccountFolder(path)) {
        return refuse(`${label}: the folder must be a full path from the root of the disk.`);
      }
      folder = { kind: "existing", path };
      destination = path;
      // `/team` and `/team/` are one folder; main resolves symlinks besides.
      // A backslash separates only in a Windows path.
      const trailing = /^(?:[A-Za-z]:|\\\\)/.test(path) ? /(?<=[^\\/])[\\/]+$/ : /(?<=[^/])\/+$/;
      key = `existing:${request.agentId}:${path.replace(trailing, "")}`;
    }
    const earlier = claimed.get(key);
    if (earlier !== undefined) {
      return refuse(`Accounts ${earlier + 1} and ${index + 1} name the same folder.`);
    }
    claimed.set(key, index);
    rows.push({
      index,
      agentId: request.agentId,
      agentTitle: getAgentDisplayTitle(request.agentId),
      name,
      folder,
      destination,
    });
  }
  return { ok: true, rows };
}

function rowFolder(row: PlannedAccountRow): string {
  return `${row.folder.kind === "create" ? "New folder" : "Existing folder"} ${row.destination}`;
}

/**
 * The rows read-only, for the dialog that asks whether a pane may reach the
 * add above its tier. Nothing is ticked there: the checklist that follows is
 * the one choice of which accounts to add, so an untick can't be lost between
 * the two.
 */
export function accountRowLines(rows: readonly PlannedAccountRow[]): string[] {
  return [
    ...rows.map((row) => `${row.name} (${row.agentTitle} account): ${rowFolder(row)}`),
    "You choose which to add in the next step.",
  ];
}

/** A row as the confirm dialog's checklist shows it, every one ticked to start. */
export function accountRowTarget(row: PlannedAccountRow): McpConfirmSelectableTarget {
  return {
    id: accountRowId(row.index),
    name: row.name,
    kindLabel: `${row.agentTitle} account`,
    agentRunning: false,
    detail: rowFolder(row),
  };
}
