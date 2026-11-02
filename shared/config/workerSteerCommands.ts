import { isBuiltInAgentId, type BuiltInAgentId } from "./agentIds.js";

/**
 * The slash commands the global Assistant may run in an agent it steers but
 * didn't launch (#16101), each as the whole input. Its own list, never the
 * slash-command registry: an entry there says nothing of arguments or harm,
 * and a user's or project's command can take a built-in's name. Fixed forms
 * only, so no free text rides in without the provenance stamp, and nothing
 * that ends the session, signs out, drops history or changes permissions.
 * Each is a fixed session control of its CLI, which a custom command or skill
 * of the same name doesn't replace.
 */
export const WORKER_STEER_SLASH_FORMS: Readonly<
  Partial<Record<BuiltInAgentId, readonly string[]>>
> = {
  claude: ["/compact"],
  gemini: ["/compress"],
  antigravity: ["/compact"],
  codex: ["/goal resume", "/goal pause", "/compact", "/status"],
};

// A command's name, never a path: `/Users/me/a.ts is broken` is a prompt.
const SLASH_COMMAND_TOKEN = /^\/[A-Za-z][\w.:-]*$/;

export type WorkerSteerCommand =
  | { kind: "prompt" }
  | { kind: "slash"; form: string }
  | { kind: "refused"; allowed: readonly string[] };

export function workerSteerSlashForms(agentId: string | undefined): readonly string[] {
  return isBuiltInAgentId(agentId) ? (WORKER_STEER_SLASH_FORMS[agentId] ?? []) : [];
}

/**
 * How a steered send's text goes in: a prompt (stamped), one of the agent's
 * fixed forms (as written, trimmed), or a slash command it can't run there.
 */
export function classifyWorkerSteerCommand(
  command: string,
  agentId: string | undefined
): WorkerSteerCommand {
  const text = command.trim();
  const name = text.split(/\s/, 1)[0] ?? "";
  if (!SLASH_COMMAND_TOKEN.test(name)) return { kind: "prompt" };
  const allowed = workerSteerSlashForms(agentId);
  return allowed.includes(text) ? { kind: "slash", form: text } : { kind: "refused", allowed };
}
