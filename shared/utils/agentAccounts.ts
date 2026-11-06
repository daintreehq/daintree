import { getAgentConfigFolderAccount } from "../config/agentRegistry.js";
import type { AgentAccount, AgentSettingsEntry } from "../types/agentSettings.js";
import { isAccountId } from "./agentAccountId.js";
import { sanitizeAgentEnv } from "./agentPresets.js";

export { isAccountId };

/**
 * Accounts as their own per-agent choice (#16040), shared by the renderer's
 * launcher, the host's viewless launch and main's account writes so all three
 * read a saved account through the same rules.
 */

export const ACCOUNT_NAME_MAX_CHARS = 60;

// A path the agent's own process reads as the same folder from any working
// directory: POSIX absolute, a Windows drive root, or a UNC share. A
// drive-relative `\profiles\work` lands on whichever drive the process is on.
const FULLY_QUALIFIED_PATH = /^(?:\/|[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1F\x7F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]+/g;

/**
 * A folder an account can name: fully qualified, and one the launch env keeps
 * as it is. A value `sanitizeAgentEnv` drops would leave the launch on the
 * default login while the pane says otherwise.
 */
export function isUsableAccountFolder(value: string): boolean {
  if (!FULLY_QUALIFIED_PATH.test(value) || CONTROL_CHARACTER.test(value)) return false;
  return sanitizeAgentEnv({ ACCOUNT_FOLDER: value })?.ACCOUNT_FOLDER === value;
}

export function sanitizeAccountName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(CONTROL_CHARACTERS, " ").trim();
  return name ? name.slice(0, ACCOUNT_NAME_MAX_CHARS) : undefined;
}

/** The saved accounts that are well formed, first of each id. Never throws. */
export function sanitizeAgentAccounts(value: unknown): AgentAccount[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const accounts: AgentAccount[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const { id, name, configDir } = raw as Record<string, unknown>;
    if (!isAccountId(id) || seen.has(id)) continue;
    const safeName = sanitizeAccountName(name);
    if (!safeName || typeof configDir !== "string" || !isUsableAccountFolder(configDir)) continue;
    seen.add(id);
    accounts.push({ id, name: safeName, configDir });
  }
  return accounts;
}

/**
 * The account id a launch asks for: the caller's, else the worktree's own
 * choice, else the account the launched preset pins (#16133), else the
 * agent's default. `null` is the CLI's default login.
 */
export function resolveEffectiveAccountId(
  entry: AgentSettingsEntry | null | undefined,
  worktreeId: string | null | undefined,
  requested?: string | null,
  presetAccountId?: string
): string | null {
  if (requested !== undefined) return requested;
  const scoped = entry?.worktreeAccounts;
  if (worktreeId && scoped && typeof scoped === "object" && Object.hasOwn(scoped, worktreeId)) {
    const id = scoped[worktreeId];
    return typeof id === "string" ? id : null;
  }
  if (typeof presetAccountId === "string") return presetAccountId;
  return typeof entry?.accountId === "string" ? entry.accountId : null;
}

export type LaunchAccountResolution =
  | { kind: "default" }
  | { kind: "account"; account: AgentAccount; envVar: string }
  /** A saved or requested id with no account behind it. Never launched on another. */
  | { kind: "missing"; accountId: string };

/**
 * Which account one launch of `agentId` runs on. `presetAccountId` is the
 * account the launched preset pins, read from the preset the launch settled on.
 */
export function resolveLaunchAccount(
  agentId: string,
  entry: AgentSettingsEntry | null | undefined,
  worktreeId: string | null | undefined,
  requested?: string | null,
  presetAccountId?: string
): LaunchAccountResolution {
  const declaration = getAgentConfigFolderAccount(agentId);
  if (!declaration) return { kind: "default" };
  const id = resolveEffectiveAccountId(entry, worktreeId, requested, presetAccountId);
  if (id === null) return { kind: "default" };
  const account = sanitizeAgentAccounts(entry?.accounts).find((candidate) => candidate.id === id);
  return account
    ? { kind: "account", account, envVar: declaration.envVar }
    : { kind: "missing", accountId: id };
}

/**
 * `env` with the account's folder set last, so it wins over a preset or caller
 * that sets the same variable. Matched case-insensitively: on Windows the
 * launched process sees `codex_home` and `CODEX_HOME` as one variable.
 */
export function withAccountEnv(
  env: Record<string, string> | undefined,
  envVar: string,
  configDir: string
): Record<string, string> {
  const upper = envVar.toUpperCase();
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key.toUpperCase() !== upper) next[key] = value;
  }
  next[envVar] = configDir;
  return next;
}

/**
 * The folder a pane launched on, read back from the launch env it captured,
 * so a relaunch keeps the pane's account rather than resolving one again.
 * `undefined` when the pane is on the default login.
 */
export function paneAccountEnv(
  agentId: string | undefined,
  pane: { agentAccountId?: string; env?: Record<string, string> }
): Record<string, string> | undefined {
  if (!agentId || !pane.agentAccountId || !pane.env) return undefined;
  const declaration = getAgentConfigFolderAccount(agentId);
  if (!declaration) return undefined;
  const upper = declaration.envVar.toUpperCase();
  const key = Object.keys(pane.env).find((name) => name.toUpperCase() === upper);
  const value = key === undefined ? undefined : pane.env[key];
  return value && isUsableAccountFolder(value) ? { [declaration.envVar]: value } : undefined;
}

/** Layer a pane's own account back over a relaunch's env. */
export function keepPaneAccount(
  env: Record<string, string> | undefined,
  agentId: string | undefined,
  pane: { agentAccountId?: string; env?: Record<string, string> }
): Record<string, string> | undefined {
  const selector = paneAccountEnv(agentId, pane);
  const entry = selector ? Object.entries(selector)[0] : undefined;
  return entry ? withAccountEnv(env, entry[0], entry[1]) : env;
}

/**
 * The folder name a new account gets beside the CLI's own: `.codex` and
 * "Company" make `.codex-company`. `undefined` when the name has nothing a
 * folder name can carry.
 */
export function accountFolderName(defaultDir: string, accountName: string): string | undefined {
  const slug = accountName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug) return undefined;
  const base =
    defaultDir
      .replace(/[\\/]+$/g, "")
      .split(/[\\/]/)
      .pop() ?? defaultDir;
  return `${base}-${slug}`;
}
