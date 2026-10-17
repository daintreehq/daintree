import { displaySafeText } from "./displaySafeText.js";
import { scrubSecrets } from "./secretScrubber.js";

const SSH_SAID_MAX = 160;

/** What ssh writes when it reached the host and couldn't log in, rather than couldn't reach it. */
export const SSH_ACCESS_DENIED =
  /Permission denied \(|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No more authentication methods|Too many authentication failures|host key for .* has changed/i;

/**
 * ssh's own words for why it couldn't log in, one line of them. Its stderr can
 * run to a screenful (a changed host key comes boxed in `@@@` warnings) and
 * may trail a "Connection closed" after the refusal, so the last line that
 * names the refusal is kept, else the last line. Anything that looks like a
 * secret is redacted: the line travels in errors, toasts and logs.
 */
export function sshRefusalLine(stderr: string | null | undefined): string | null {
  const lines = (stderr ?? "")
    .split(/\r?\n/)
    .map((part) => displaySafeText(part).trim())
    .filter((part) => part.length > 0 && !part.startsWith("@@@"));
  const refusal = lines.filter((part) => SSH_ACCESS_DENIED.test(part)).at(-1);
  const line = refusal ?? lines.at(-1);
  if (!line) return null;
  const trimmed = scrubSecrets(line).replace(/[.\s]+$/, "");
  if (trimmed.length === 0) return null;
  return trimmed.length > SSH_SAID_MAX ? `${trimmed.slice(0, SSH_SAID_MAX - 1)}…` : trimmed;
}
