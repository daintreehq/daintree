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
  sanitizeLoginName,
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

/** The saved accounts a folder check reads. */
function savedFolders(agentId: string): AgentAccount[] {
  return sanitizeAgentAccounts(readSettings().agents[agentId]?.accounts);
}

function claimedBy(account: AgentAccount): Error {
  return invalid(`That folder is already the account '${account.name}'.`);
}

/**
 * Runs `write` once no other of the agent's accounts is the existing `folder`,
 * by its real path. Resolving each saved folder awaits, so another add can
 * land meanwhile (a batch from an agent and the Settings dialog, say). Each
 * pass resolves only accounts it hasn't checked, and `write` runs in the same
 * turn as a read that shows none left: an await between the two would let
 * another add's last check run in the gap.
 */
async function writeIfUnclaimed<T>(agentId: string, folder: string, write: () => T): Promise<T> {
  const identity = await folderIdentity(folder);
  const checked = new Set<string>();
  const key = (account: AgentAccount) => `${account.id}\0${account.configDir}`;
  for (;;) {
    const unchecked = savedFolders(agentId).filter((account) => !checked.has(key(account)));
    if (unchecked.length === 0) return write();
    for (const account of unchecked) {
      if ((await folderIdentity(account.configDir)) === identity) throw claimedBy(account);
      checked.add(key(account));
    }
  }
}

export async function addAgentAccount(
  request: AddAgentAccountRequest
): Promise<AddAgentAccountResult> {
  if (!isPlainRecord(request)) throw invalid("Invalid account");
  const { agentId, declaration } = folderAccount(request.agentId);
  const name = sanitizeAccountName(request.name);
  if (!name) throw invalid("Give the account a name");

  const register = (configDir: string): AddAgentAccountResult => {
    // Read again in the same turn as the write: another view may have written
    // anything meanwhile.
    const entry = readSettings().agents[agentId] ?? {};
    const account: AgentAccount = { id: `account-${randomUUID()}`, name, configDir };
    const accounts = [...sanitizeAgentAccounts(entry.accounts), account];
    const settings = writeAgentEntry(agentId, { ...entry, accounts });
    return { account, settings };
  };

  if (request.folder?.kind === "existing") {
    const configDir = await checkExistingFolder(request.folder.path);
    return writeIfUnclaimed(agentId, configDir, () => register(configDir));
  }
  if (request.folder?.kind === "create") {
    const configDir = await createFolder(declaration.defaultDir, name);
    // Made just now and refused if it was there, so only an account saved
    // under this very path (its folder since deleted) can already be it.
    // Checked in the write's own turn, with nothing to resolve.
    const owner = savedFolders(agentId).find((account) => account.configDir === configDir);
    if (owner) throw claimedBy(owner);
    return register(configDir);
  }
  throw invalid("Choose where the account's folder is");
}

/**
 * Forgets an account. Every choice that named it, presets' pins included,
 * goes back to inheriting, so no launch is left pointing at an account that
 * isn't there. The folder stays
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
  // A preset that pinned it goes back to the worktree's or the agent's account (#16133).
  if (Array.isArray(entry.customPresets)) {
    next.customPresets = entry.customPresets.map((preset) => {
      if (!isPlainRecord(preset) || preset.accountId !== accountId) return preset;
      const { accountId: _removed, ...rest } = preset;
      return rest as typeof preset;
    });
  }
  return writeAgentEntry(id, next);
}

/**
 * Renames one login by id (#17080): a saved account, or with `accountId`
 * null the CLI's own default login, whose name only changes what is shown.
 * Read and written here in one step, so a rename never brings back an account
 * another view removed or drops one it added, and every choice that names
 * the account keeps naming it. An empty name clears the default login's name
 * and is refused for a saved account.
 */
export function renameAgentAccount(
  agentId: unknown,
  accountId: unknown,
  rawName: unknown
): AgentSettings {
  const { agentId: id } = folderAccount(agentId);
  // A missing argument is refused rather than read as clearing the name.
  if (typeof rawName !== "string") throw invalid("Invalid account name");
  const name = sanitizeLoginName(rawName);
  const entry = readSettings().agents[id] ?? {};

  if (accountId === null) {
    const next: AgentSettingsEntry = { ...entry };
    if (name) next.defaultLoginName = name;
    else delete next.defaultLoginName;
    return writeAgentEntry(id, next);
  }

  if (!isAccountId(accountId)) throw invalid("Invalid account");
  if (!name) throw invalid("Give the account a name");
  const accounts = sanitizeAgentAccounts(entry.accounts);
  const index = accounts.findIndex((account) => account.id === accountId);
  if (index < 0) throw invalid("That account isn't saved any more.");
  accounts[index] = { ...accounts[index]!, name };
  return writeAgentEntry(id, { ...entry, accounts });
}
