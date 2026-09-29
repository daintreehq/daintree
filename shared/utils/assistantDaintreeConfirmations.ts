import type { HelpAssistantDaintreeConfirmations } from "../types/ipc/api.js";

export function isHelpAssistantDaintreeConfirmations(
  value: unknown
): value is HelpAssistantDaintreeConfirmations {
  return value === "inherit" || value === "always-ask" || value === "never-ask";
}

/**
 * Whether the assistant's Daintree confirmations are skipped (#12874, #12989).
 * `never-ask` skips whatever the global "Skip permission prompts" says,
 * `always-ask` never skips, and `inherit` follows the global. An absent or
 * unrecognised preference reads as the default, `inherit`.
 */
export function assistantSkipsDaintreeConfirmations(
  preference: HelpAssistantDaintreeConfirmations | undefined,
  globalSkipPermissions: boolean | undefined
): boolean {
  if (preference === "never-ask") return true;
  if (preference === "always-ask") return false;
  return globalSkipPermissions === true;
}
