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

/**
 * What ssh says when a ProxyJump or ProxyCommand hop closed the connection
 * before the host's banner arrived. On a call that may start a master
 * (ControlPersist), ssh sends that hop's stderr to /dev/null, so a jump host
 * that refused the login says nothing more than this.
 */
const PROXY_CLOSED_EARLY = /Connection closed by UNKNOWN port 65535/;

export function isProxyClosedEarly(stderr: string | null | undefined): boolean {
  return PROXY_CLOSED_EARLY.test(stderr ?? "");
}

export type SshRefusalAdvice = "untrusted-host-key" | "changed-host-key" | "login-refused";

/**
 * What ssh's own words say stopped a call that BatchMode refused, so the next
 * step can be named. Callers keep only the last lines of stderr, so a changed
 * key is told apart by its "has changed" or "Offending" line rather than the
 * banner above them. `login-refused` is the only one a sign-in may follow: by
 * then the host key has already passed.
 */
export function sshRefusalAdvice(sshError: string | null | undefined): SshRefusalAdvice | null {
  if (!sshError) return null;
  if (
    /^Host key for \S+ has changed\b|REMOTE HOST IDENTIFICATION HAS CHANGED|^Offending \S+ key in /im.test(
      sshError
    )
  ) {
    return "changed-host-key";
  }
  if (/Host key verification failed|No \S+ host key is known/i.test(sshError)) {
    return "untrusted-host-key";
  }
  if (LOGIN_REFUSED.test(sshError)) return "login-refused";
  return null;
}

/**
 * ssh's own authentication refusal, which lists the methods the server still
 * offered (`Permission denied (publickey,keyboard-interactive).`); a command
 * on the host that prints "Permission denied (restricted command)" isn't one.
 */
const LOGIN_REFUSED = /Permission denied \([a-z0-9@.-]+(?:,[a-z0-9@.-]+)*\)/i;
