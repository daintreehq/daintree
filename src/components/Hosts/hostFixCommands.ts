import {
  HOST_PACKAGES_COMMAND,
  withoutHostPackagesInstruction,
} from "@shared/config/linuxHostPackages";

/** An error's words with a fix Daintree knows taken out of them, and that fix. */
export interface HostErrorFix {
  text: string;
  /** A command to run as root on the host itself; null when the words name no known fix. */
  rootCommand: string | null;
}

/**
 * Takes the package install a refused Linux start names out of its words,
 * wherever it sits, so the words read as a sentence and the command is shown
 * once, whole, to copy. Only the exact text main writes counts, so words cut
 * short keep what they say and offer no command.
 */
export function splitHostFix(message: string): HostErrorFix {
  const { text, found } = withoutHostPackagesInstruction(message);
  return found
    ? { text, rootCommand: HOST_PACKAGES_COMMAND }
    : { text: message, rootCommand: null };
}
