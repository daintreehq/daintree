import type { HelpAssistantDaintreeConfirmations } from "../types/ipc/api.js";

/**
 * Whether the assistant's confirm-gated Daintree actions run without asking
 * (#12874). The global "Skip permission prompts" is the one place a user says
 * "don't ask", so the assistant's own preference can only make this stricter:
 * `always-ask` keeps the dialog, and nothing skips while the global is off.
 * An absent or unrecognised preference reads as the default, `inherit`.
 */
export function assistantSkipsDaintreeConfirmations(
  preference: HelpAssistantDaintreeConfirmations | undefined,
  globalSkipPermissions: boolean | undefined
): boolean {
  return preference !== "always-ask" && globalSkipPermissions === true;
}
