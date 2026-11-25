/**
 * The fixed words each agent CLI asks its folder-trust question in (#18170).
 * The waiting-reason classifier reads them to tell a trust prompt from any
 * other selector; the assistant's readiness reader answers the prompt, and
 * only for the assistant's own session folder.
 */

/** Claude Code's option that trusts the folder, and the label that answers it. */
export const CLAUDE_TRUST_OPTION = "Yes, I trust this folder";

/** Codex's folder-trust question. */
export const CODEX_TRUST_QUESTION = /Do you trust the contents of this directory/i;

/**
 * One way a CLI draws its trust prompt: an option only that prompt offers,
 * matched from the start of one of the open selector's options, and, when the
 * option alone could be another dialog's, the question asked above them. A
 * phrase may stop at the row's end, where a narrow pane wrapped its last word.
 */
export interface TrustPromptForm {
  option: RegExp;
  question?: RegExp;
}

const TRUST_PROMPT_FORMS: Readonly<Record<string, readonly TrustPromptForm[]>> = {
  claude: [
    { option: /^Yes, I trust this(?:\s+folder\b|\s*$)/ },
    // Older builds ask it outright, over "1. Yes, proceed".
    { option: /^Yes, proceed\b/, question: /^Do you trust the files in this(?:\s+folder\b|\s*$)/ },
  ],
  codex: [
    // "Trust this folder?" over "Trust and continue" since 0.156, "Do you trust
    // the contents of this directory?" over "Yes, continue" before it.
    {
      option: /^(?:Trust and continue|Yes, continue)\b/,
      question:
        /^(?:Trust this folder\?|Do you trust the contents of this(?:\s+directory\b|\s*$))/i,
    },
  ],
};

/** The trust prompts `agentId`'s CLI draws, or undefined for a CLI whose wording isn't known. */
export function trustPromptFormsFor(
  agentId: string | undefined
): readonly TrustPromptForm[] | undefined {
  return agentId !== undefined && Object.hasOwn(TRUST_PROMPT_FORMS, agentId)
    ? TRUST_PROMPT_FORMS[agentId]
    : undefined;
}
