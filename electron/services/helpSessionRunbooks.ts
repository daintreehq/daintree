import { WORKER_STEER_SLASH_FORMS } from "../../shared/config/workerSteerCommands.js";

// What a steer runs as a slash command (#16101), read off the policy that enforces it.
const STEER_SLASH_FORMS = Object.entries(WORKER_STEER_SLASH_FORMS)
  .map(([agentId, forms]) => `${agentId}: ${forms.map((form) => `\`${form}\``).join(", ")}`)
  .join("; ");

export const DAINTREE_DOCS_MCP_URL = "https://daintree.org/api/mcp";

export const RUNBOOKS_MCP_SERVER_NAME = "daintree-runbooks";
export const DAINTREE_RUNBOOKS_MCP_URL = "https://assistant.daintree.org/v1/daintree/mcp";
// Developer override for pointing help sessions at a local runbook server while
// the catalog is being rewritten. Deliberately not a setting: users always get
// the production endpoint.
export const RUNBOOKS_MCP_URL_ENV_VAR = "DAINTREE_RUNBOOKS_MCP_URL";

/**
 * Names the model this build drives its hosts with (#13496): direct control
 * through `host.call`, delegation as agent messaging, no inbox. The runbook
 * server picks its catalog by it (daintreehq/assistant-backend#159); absent,
 * as from v0.44, it serves the inbox model's catalog.
 */
export const RUNBOOKS_HOST_CONTROL_HEADER = "Daintree-Host-Control";
export const RUNBOOKS_HOST_CONTROL_VERSION = "1";

/**
 * The request headers runbook search reads, sent on every POST by the agent
 * CLI: the host-control model, which is this build's whatever its hosts.
 * The `Daintree-Hosts` state the server can also filter by is never sent
 * (#14458). Each native CLI holds its headers from launch for the life of
 * the process, so a reported state would go stale the moment a host is added,
 * connected or let go, and hide the procedures for it until the assistant
 * relaunched. Unreported, search keeps the whole catalog eligible; `host.list`
 * and `host.call` report and check the live hosts.
 */
export function buildRunbooksHeaders(): Record<string, string> {
  return { [RUNBOOKS_HOST_CONTROL_HEADER]: RUNBOOKS_HOST_CONTROL_VERSION };
}

export const RUNBOOKS_BLOCK_START = "<!-- DAINTREE_RUNBOOKS_START -->";
export const RUNBOOKS_BLOCK_END = "<!-- DAINTREE_RUNBOOKS_END -->";

/**
 * The runbook endpoint for this process. An override must be a plain http(s)
 * URL: it lands inside a quoted TOML `-c` value for Codex and a JSON config for
 * Claude and Copilot, so anything that could break out of either is refused in
 * favour of the production URL.
 */
export function resolveRunbooksMcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[RUNBOOKS_MCP_URL_ENV_VAR]?.trim();
  if (!raw) return DAINTREE_RUNBOOKS_MCP_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`[HelpSessionService] Ignoring ${RUNBOOKS_MCP_URL_ENV_VAR}: not a URL`);
    return DAINTREE_RUNBOOKS_MCP_URL;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    /["'\\\s]/.test(raw)
  ) {
    console.warn(`[HelpSessionService] Ignoring ${RUNBOOKS_MCP_URL_ENV_VAR}: unsupported URL`);
    return DAINTREE_RUNBOOKS_MCP_URL;
  }
  return raw;
}

/**
 * The runbook rule, written into the slot near the top of the session's
 * CLAUDE.md and AGENTS.md only while runbook search is on — so when the user
 * turns it off the rule is gone rather than hedged with "unless disabled".
 *
 * The query guidance is measured, not stylistic: against the selector, a
 * one-sentence summary in the user's voice routed as well as the raw message,
 * while three-word phrases dropped halves of compound tasks and third-person or
 * "ask …" phrasings were misread as the agent-question runbooks. `max_results`
 * matches the selector's own cap of three admitted runbooks; every result
 * carries its full procedure, so asking for more only buys unselected text.
 *
 * The tool-name line follows the caller's real surface (#14161). A project's
 * assistant holds the unscoped terminal tools in its own project, and only
 * there; every project `host.call` reaches admits the owned tools alone. The
 * global assistant has no project of its own, so it is never told to swap.
 */
export function buildRunbooksAddendum(caller: { global?: boolean } = {}): string {
  const toolNames = caller.global
    ? "**Tool names:** you have no project of your own: `host.list` finds projects, a page per host (follow `projectInventory.nextCursor`, or narrow by `projectQuery`, before calling one missing), and every step a runbook gives runs through `host.call` with that project's `hostId` and `projectId` (`local` for this machine). Call the tools it names as written, `terminal.sendCommandOwned`, `terminal.sendKeysOwned` and `terminal.closeOwned` included. Prompting, keys and `terminal.interruptOwned` also reach an agent you didn't launch, given its `incarnation` from `host.list` as `generation`; you can close only what you launched. There a slash command runs only as one of its agent's fixed forms (" +
      STEER_SLASH_FORMS +
      "), sent alone without `handback`; for any other, ask the person to type it, or to hand you the pane if it runs on this machine. Their `notify` steps apply to you too. A host's own settings, turning Canopy on included, are read and changed with `host.settings`, never through `host.call`. Holding work for a host that is down or busy, arm one notice for when its link or a fresh sample changes with `host.watch`, and list hosts again before acting on it."
    : "**Tool names:** runbooks are written for every caller. In your own project, where one says `terminal.sendCommandOwned`, `terminal.sendKeysOwned` or `terminal.closeOwned`, yours is `terminal.sendCommand`, `terminal.sendKeys` or `terminal.close`, with the same arguments; don't look the owned names up. Through `host.call` use the owned names as written. Their `notify` steps apply to you too.";
  return [
    "## Runbooks First",
    "",
    `\`${RUNBOOKS_MCP_SERVER_NAME}\` is on, and it comes before everything below: \`search_runbooks\` returns Daintree's procedure for a task, and following it is how you do the task.`,
    "",
    '**Never search for chat or a "how do I…" question:** answer Daintree ones from `daintree-docs`; runbooks are procedures, not documentation. **Before acting on any request to do something, call it** — before your first `daintree` call, even when it looks simple. A question about live state ("how much usage is left?", "why is it slow?") is a task. **One search per task:** never search for a step of it, a follow-up on it (closing its agents included) or a notice; those run on the runbooks you have.',
    "",
    '`query`: one sentence, 8–15 words, saying what the user wants done as they would type it. Keep every part of the task and any condition on how ("…and start an agent on it", "…without fixing anything"). Leave out specifics: numbers, branch, file, repo and people\'s names, pasted output, prompt text. Don\'t narrate ("User wants…", "ask whether…"). Pass `max_results: 3`.',
    "",
    toolNames,
    "",
    `Follow the runbooks with \`selected: true\` and the \`supporting_runbooks\` that come with them (the foundation they build on), and ignore the unselected ones. None selected: carry on and don't mention it. Another step naming a tool you lack: find the equivalent with \`actions.search\`${caller.global ? " through `host.call`" : ""}, or tell the user. If the search fails, retry once, then proceed and say the runbook couldn't be loaded.`,
    "",
  ].join("\n");
}

export const CONFIRMATIONS_BLOCK_START = "<!-- DAINTREE_CONFIRMATIONS_START -->";
export const CONFIRMATIONS_BLOCK_END = "<!-- DAINTREE_CONFIRMATIONS_END -->";

/**
 * The session-start correction for the skip preference (#12874). The shared
 * prompt says confirm-gated actions wait for the user, and it is at its size
 * budget, so the exception is written here rather than there. It can go stale
 * if the user changes the setting mid-session; the assistant still sees each
 * call either run or wait.
 */
export function buildConfirmationsAddendum(): string {
  return [
    "## Daintree Confirmations",
    "",
    "The user has told Daintree not to ask before your actions. Confirm-gated Daintree actions run as soon as you call them: deleting a worktree, closing a panel you didn't open or whose agent is mid-task, and closing panels in bulk included. No dialog, no typed-name check, so don't tell the user to watch for one. This overrides anything above about those actions waiting for the user. It doesn't change what you should do: close and remove only what the user asked for. Refusals still apply, and so does asking for a tool outside your tool set. The user can turn asking back on at any time, so if a call does wait for a dialog, tell them it is waiting for them.",
    "",
  ].join("\n");
}

/**
 * Where an older build wrote its rules for messages between assistants into a
 * session's CLAUDE.md and AGENTS.md. Retired with the inbox (#13496): a reused
 * session folder has the block stripped.
 */
export const MESSAGING_BLOCK_START = "<!-- DAINTREE_MESSAGING_START -->";
export const MESSAGING_BLOCK_END = "<!-- DAINTREE_MESSAGING_END -->";
