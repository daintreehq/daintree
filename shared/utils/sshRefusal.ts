import { displaySafeText } from "./displaySafeText.js";

const SSH_SAID_MAX = 160;

/**
 * ssh's own words for why it couldn't log in, one line of them. Its stderr can
 * run to a screenful (a changed host key comes boxed in `@@@` warnings) and
 * ends on the refusal itself, so that last line is the one kept.
 */
export function sshRefusalLine(stderr: string | null | undefined): string | null {
  const lines = (stderr ?? "")
    .split(/\r?\n/)
    .map((part) => displaySafeText(part).trim())
    .filter((part) => part.length > 0 && !part.startsWith("@@@"));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const trimmed = line.replace(/[.\s]+$/, "");
  if (trimmed.length === 0) return null;
  return trimmed.length > SSH_SAID_MAX ? `${trimmed.slice(0, SSH_SAID_MAX - 1)}…` : trimmed;
}
