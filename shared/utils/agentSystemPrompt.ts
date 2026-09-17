import { getEffectiveAgentConfig } from "../config/agentRegistry.js";

/**
 * Longest standing instruction `agent.launch` accepts (#12431). The text lands
 * inside a single shell command line, which cmd.exe caps at 8,191 characters
 * for the whole launch, quoting included.
 */
export const SYSTEM_PROMPT_MAX_LENGTH = 2000;

export type SystemPromptArgsResult = { ok: true; args: string[] } | { ok: false; reason: string };

function isLineBreakOrControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/**
 * Reduces a standing instruction to one line of plain text, or `undefined`
 * when nothing is left. A line break would end the launch command early and
 * other controls would reach the terminal as escape sequences, so each run of
 * them becomes one space — the same flattening `generateAgentCommand` applies
 * to the first-turn prompt. A lone surrogate is not text, and a TOML parser
 * rejects its escape, so it becomes U+FFFD.
 */
export function normalizeSystemPrompt(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let normalized = "";
  let inControlRun = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isLineBreakOrControl(code)) {
      if (!inControlRun) normalized += " ";
      inControlRun = true;
      continue;
    }
    inControlRun = false;
    normalized += code >= 0xd800 && code <= 0xdfff ? "\ufffd" : char;
  }
  return normalized.trim() || undefined;
}

/**
 * Maps an agent-neutral standing instruction onto the launch arguments the
 * agent's CLI appends to its system prompt with, as declared by its registry
 * `appendSystemPrompt` capability. Blank text maps to no arguments. The
 * returned pair is raw argv, not shell syntax: the command builders quote it.
 *
 * Refuses rather than guesses. An agent with no append option would otherwise
 * launch without the instruction the caller is relying on, and text starting
 * with `-` would be read as an option — by the CLI, and by the command
 * builders, which pass dash-prefixed tokens through unquoted.
 */
export function resolveSystemPromptArgs(
  agentId: string,
  systemPrompt: string | undefined
): SystemPromptArgsResult {
  const text = normalizeSystemPrompt(systemPrompt);
  if (!text) return { ok: true, args: [] };
  const agentConfig = getEffectiveAgentConfig(agentId);
  const append = agentConfig?.capabilities?.appendSystemPrompt;
  if (!append) {
    return {
      ok: false,
      reason: `${agentConfig?.name ?? agentId} has no launch option that appends to its system prompt, so it can't take a systemPrompt. Launch it without one.`,
    };
  }
  if (text.length > SYSTEM_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      reason: `systemPrompt is limited to ${SYSTEM_PROMPT_MAX_LENGTH} characters.`,
    };
  }
  if (text.startsWith("-")) {
    return {
      ok: false,
      reason: "systemPrompt can't start with '-', which the agent CLI would read as an option.",
    };
  }
  // A JSON string is a valid TOML basic string once the text holds no
  // control characters or lone surrogates, which normalization guarantees.
  const value = append.configKey ? `${append.configKey}=${JSON.stringify(text)}` : text;
  return { ok: true, args: [append.flag, value] };
}

/**
 * The standing-instruction pair already present in a persisted launch-flag
 * snapshot, so a path that rebuilds the flags from current settings (a stale
 * or fallback preset, a duplicate, a cloned layout) can carry it over
 * verbatim. Returns the last pair, the one the CLI honours, or `[]`.
 */
export function extractSystemPromptArgs(
  flags: readonly string[] | undefined,
  agentId: string
): string[] {
  if (!flags?.length) return [];
  const append = getEffectiveAgentConfig(agentId)?.capabilities?.appendSystemPrompt;
  if (!append) return [];
  const valuePrefix = append.configKey ? `${append.configKey}=` : "";
  for (let i = flags.length - 2; i >= 0; i--) {
    const value = flags[i + 1];
    if (
      flags[i] === append.flag &&
      value !== undefined &&
      value.startsWith(valuePrefix) &&
      !value.startsWith("-")
    ) {
      return [append.flag, value];
    }
  }
  return [];
}
