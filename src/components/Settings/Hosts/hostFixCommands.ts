import { HOST_PACKAGES_COMMAND, HOST_PACKAGES_INSTRUCTION } from "@shared/config/linuxHostPackages";

/** An error's words with a fix Daintree knows taken out of them, and that fix. */
export interface HostErrorFix {
  text: string;
  /** A command to run as root on the host itself; null when the words name no known fix. */
  rootCommand: string | null;
}

/**
 * Takes the package install a refused Linux start names out of its words,
 * wherever it sits: after a Connect or Bring back prefix, before an
 * installer's recovery note, or twice over after a rollback. The words then
 * read as a sentence and the command is shown once, whole, to copy. Only the
 * exact text main writes counts, so words cut short keep what they say and
 * offer no command.
 */
export function splitHostFix(message: string): HostErrorFix {
  let text = message;
  let found = false;
  for (let at = text.indexOf(HOST_PACKAGES_INSTRUCTION); at >= 0; ) {
    found = true;
    const before = text.slice(0, at).replace(/ $/, "");
    let after = text.slice(at + HOST_PACKAGES_INSTRUCTION.length);
    // An installer's note joins with ". " after the command; the sentence before has its own stop.
    if (after.startsWith(".") && /[.!?]$/.test(before)) after = after.slice(1);
    text = before + after;
    at = text.indexOf(HOST_PACKAGES_INSTRUCTION);
  }
  return found
    ? { text: text.trim(), rootCommand: HOST_PACKAGES_COMMAND }
    : { text: message, rootCommand: null };
}
