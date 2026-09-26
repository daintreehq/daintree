export const DAINTREE_DOCS_MCP_URL = "https://daintree.org/api/mcp";

export const RUNBOOKS_MCP_SERVER_NAME = "daintree-runbooks";
export const DAINTREE_RUNBOOKS_MCP_URL = "https://assistant.daintree.org/v1/daintree/mcp";
// Developer override for pointing help sessions at a local runbook server while
// the catalog is being rewritten. Deliberately not a setting: users always get
// the production endpoint.
export const RUNBOOKS_MCP_URL_ENV_VAR = "DAINTREE_RUNBOOKS_MCP_URL";

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
 */
export function buildRunbooksAddendum(): string {
  return [
    "## Runbooks First",
    "",
    `\`${RUNBOOKS_MCP_SERVER_NAME}\` is on, and it comes before everything below: \`search_runbooks\` returns Daintree's procedure for a task, and following it is how you do the task.`,
    "",
    '**Before acting on any request to do something, call it** — before your first `daintree` call, even when it looks simple. **One search per task:** never search for a step of it, a follow-up on it (closing its agents included) or a notice; those run on the runbooks you have. Only chat and "how do I…" questions skip it: answer those from the docs. A question about live state ("how much usage is left?", "why is it slow?") is a task.',
    "",
    '`query`: one sentence, 8–15 words, saying what the user wants done as they would type it. Keep every part of the task and any condition on how ("…and start an agent on it", "…without fixing anything"). Leave out specifics: numbers, branch, file, repo and people\'s names, pasted output, prompt text. Don\'t narrate ("User wants…", "ask whether…"). Pass `max_results: 3`.',
    "",
    "**Tool names:** runbooks are written for every caller. Where one says `terminal.sendCommandOwned`, `terminal.sendKeysOwned` or `terminal.closeOwned`, yours is `terminal.sendCommand`, `terminal.sendKeys` or `terminal.close`, with the same arguments; don't look the owned names up. Their `notify` steps apply to you too.",
    "",
    "Follow the runbooks with `selected: true` and the `supporting_runbooks` that come with them (the foundation they build on), and ignore the unselected ones. None selected: carry on and don't mention it. Another step naming a tool you lack: find the equivalent with `actions.search`, or tell the user. If the search fails, retry once, then proceed and say the runbook couldn't be loaded.",
    "",
  ].join("\n");
}
