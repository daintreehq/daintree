/**
 * An agent's accounts (#16040): adding one makes or checks its folder and
 * saves the entry in the same write, so a renderer never holds a folder that
 * isn't saved or saves one that isn't there.
 *
 * Within Hard Line 1: a folder is created only when the user adds an account,
 * fresh and empty, in the home directory under a name they'd recognise, so
 * resetting Daintree never takes it along. The CLI's own login fills it.
 * Nothing here writes inside a folder, and removing an account forgets the
 * entry only.
 */

import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { AppError } from "../utils/errorTypes.js";
import { getAgentConfigFolderAccount } from "../../shared/config/agentRegistry.js";
import {
  DEFAULT_AGENT_SETTINGS,
  type AgentAccount,
  type AgentSettings,
  type AgentSettingsEntry,
} from "../../shared/types/agentSettings.js";
import type {
  AddAgentAccountRequest,
  AddAgentAccountResult,
} from "../../shared/types/ipc/agentAccounts.js";
import {
  accountFolderName,
  isAccountId,
  isUsableAccountFolder,
  sanitizeAccountName,
  sanitizeAgentAccounts,
} from "../../shared/utils/agentAccounts.js";

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

function folderAccount(agentId: unknown) {
  if (typeof agentId !== "string" || RESERVED_KEYS.has(agentId)) throw invalid("Invalid agent");
  const declaration = getAgentConfigFolderAccount(agentId);
  if (!declaration) throw invalid("This agent has no accounts to add");
  return { agentId, declaration };
}

function readSettings(): {
  root: Record<string, unknown>;
  agents: Record<string, AgentSettingsEntry>;
} {
  const raw = store.get("agentSettings", DEFAULT_AGENT_SETTINGS) as unknown;
  const root = isPlainRecord(raw) ? { ...raw } : {};
  const agents: Record<string, AgentSettingsEntry> = {};
  if (isPlainRecord(root.agents)) {
    for (const [id, entry] of Object.entries(root.agents)) {
      if (id && !RESERVED_KEYS.has(id) && isPlainRecord(entry)) agents[id] = { ...entry };
    }
  }
  return { root, agents };
}

/** Writes one agent's entry at the `agents` level, as the settings handler does, and tells every view. */
function writeAgentEntry(agentId: string, entry: AgentSettingsEntry): AgentSettings {
  const { root, agents } = readSettings();
  const updatedAgents = { ...agents, [agentId]: entry };
  store.set("agentSettings.agents", updatedAgents);
  const saved = store.get("agentSettings");
  broadcastToRenderer(CHANNELS.AGENT_SETTINGS_CHANGED, saved);
  return { ...root, agents: updatedAgents } as AgentSettings;
}

function fsCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

// Folder paths stay out of every message: a thrown IPC error is logged, and a
// home path names the user.
async function createFolder(defaultDir: string, accountName: string): Promise<string> {
  const folderName = accountFolderName(defaultDir, accountName);
  if (!folderName) throw invalid("Give the account a name with letters or numbers in it");
  const folder = path.join(os.homedir(), folderName);
  try {
    // Not recursive: the home directory is there, and an existing folder is
    // refused rather than taken over.
    await mkdir(folder, { mode: 0o700 });
  } catch (error) {
    if (fsCode(error) === "EEXIST") {
      throw invalid(
        `A folder named ${folderName} already exists. Use it as an existing folder, or choose another name.`
      );
    }
    if (fsCode(error) === "EACCES" || fsCode(error) === "EPERM") {
      throw new AppError({
        code: "PERMISSION",
        message: "Couldn't create the account folder",
        userMessage: "Couldn't create the account folder: permission denied.",
      });
    }
    // The code only: the raw error names the folder's full path.
    throw new AppError({
      code: "VALIDATION",
      message: `Couldn't create the account folder (${fsCode(error) ?? "unknown"})`,
      userMessage: "Couldn't create the account folder.",
    });
  }
  return folder;
}

// What this host's own processes read as one folder from any working
// directory: on Windows a drive root or a UNC share (a drive-relative path
// lands on whichever drive the agent starts on), elsewhere a path from `/`.
function isFullyQualifiedOnHost(folder: string): boolean {
  return process.platform === "win32"
    ? /^[A-Za-z]:[\\/]/.test(folder) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(folder)
    : folder.startsWith("/");
}

async function checkExistingFolder(raw: unknown): Promise<string> {
  const folder = typeof raw === "string" ? raw.trim() : "";
  if (!isUsableAccountFolder(folder) || !isFullyQualifiedOnHost(folder)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Account folder must be a full path",
      userMessage: "Enter the folder's full path, starting from the root of the disk.",
    });
  }
  try {
    const info = await stat(folder);
    if (!info.isDirectory()) {
      throw new AppError({
        code: "NOT_A_DIRECTORY",
        message: "Account folder isn't a folder",
        userMessage: "That path is a file, not a folder.",
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (fsCode(error) === "ENOENT") {
      throw new AppError({
        code: "NOT_FOUND",
        message: "Account folder not found",
        userMessage: "There's no folder at that path.",
      });
    }
    throw new AppError({
      code: "PERMISSION",
      message: "Couldn't read the account folder",
      userMessage: "Couldn't read that folder.",
    });
  }
  return folder;
}

async function folderIdentity(folder: string): Promise<string> {
  const resolved = await realpath(folder).catch(() => path.resolve(folder));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function addAgentAccount(
  request: AddAgentAccountRequest
): Promise<AddAgentAccountResult> {
  if (!isPlainRecord(request)) throw invalid("Invalid account");
  const { agentId, declaration } = folderAccount(request.agentId);
  const name = sanitizeAccountName(request.name);
  if (!name) throw invalid("Give the account a name");

  let configDir: string;
  if (request.folder?.kind === "existing") {
    configDir = await checkExistingFolder(request.folder.path);
    const identity = await folderIdentity(configDir);
    const current = sanitizeAgentAccounts(readSettings().agents[agentId]?.accounts);
    for (const account of current) {
      if ((await folderIdentity(account.configDir)) === identity) {
        throw invalid(`That folder is already the account '${account.name}'.`);
      }
    }
  } else if (request.folder?.kind === "create") {
    configDir = await createFolder(declaration.defaultDir, name);
  } else {
    throw invalid("Choose where the account's folder is");
  }

  // Read again after the folder step: another view may have written meanwhile.
  const entry = readSettings().agents[agentId] ?? {};
  const account: AgentAccount = { id: `account-${randomUUID()}`, name, configDir };
  const accounts = [...sanitizeAgentAccounts(entry.accounts), account];
  const settings = writeAgentEntry(agentId, { ...entry, accounts });
  return { account, settings };
}

/**
 * Forgets an account. Every choice that named it goes back to inheriting, so
 * no launch is left pointing at an account that isn't there. The folder stays
 * where it is: it holds the user's login and history.
 */
export function removeAgentAccount(agentId: unknown, accountId: unknown): AgentSettings {
  const { agentId: id } = folderAccount(agentId);
  if (!isAccountId(accountId)) throw invalid("Invalid account");
  const entry = readSettings().agents[id] ?? {};
  const accounts = sanitizeAgentAccounts(entry.accounts).filter(
    (account) => account.id !== accountId
  );
  const next: AgentSettingsEntry = {
    ...entry,
    accounts: accounts.length > 0 ? accounts : undefined,
  };
  if (entry.accountId === accountId) delete next.accountId;
  if (isPlainRecord(entry.worktreeAccounts)) {
    const scoped = Object.fromEntries(
      Object.entries(entry.worktreeAccounts).filter(([, value]) => value !== accountId)
    ) as Record<string, string | null>;
    next.worktreeAccounts = Object.keys(scoped).length > 0 ? scoped : undefined;
  }
  return writeAgentEntry(id, next);
}
