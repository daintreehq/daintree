import {
  assistantBackendEnvironment,
  type AssistantBackendEnvironment,
} from "../../../shared/config/assistantBackend.js";

/**
 * The one place the assistant's backend endpoint is decided.
 *
 * Extracted from `AssistantHostService` when sign-in landed, because two processes now
 * need the answer and they must not disagree. The engine spawn resolves it here; so does
 * the account service that runs `auth login` and `auth status`. Before this existed the
 * account service passed no environment at all and simply inherited the shell's, which
 * meant you could sign in against one backend and have every turn go to another — with
 * nothing anywhere reporting the mismatch.
 *
 * ## What may choose the endpoint, and what may not
 *
 * A CHOICE made in Settings may select any environment we operate, including a remote
 * one. It is deliberate, it is per-install, and the picker says what each option means.
 *
 * `DAINTREE_BACKEND_URL` may only move the endpoint WITHIN loopback. That asymmetry is
 * the whole point and it is not an oversight: the threat this guard was written for is
 * an *inherited* variable — one exported in a shell months ago, or set by a parent
 * process, or left in a CI environment — silently routing every prompt, file path and
 * command the assistant carries to somewhere nobody chose. A settings picker cannot be
 * set by accident; an environment variable is set by accident constantly. So the
 * variable keeps its original ceiling, and the deliberate choice gets the new one.
 *
 * The practical consequence, stated because it will surprise someone: exporting
 * `DAINTREE_BACKEND_URL=https://staging.daintree.org` does NOT reach staging. Choose
 * Staging in Settings instead. The variable remains what it has always been — a way to
 * point a developer's build at a backend on their own machine.
 */

/** Hostnames that mean "this machine". `[::1]` arrives bracketed from a URL. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether a URL hostname names this machine.
 *
 * Read AFTER the URL parser, which is what makes this safe to do by name: WHATWG
 * normalises the IPv4 shorthands an allowlist would otherwise have to know about
 * (`http://2130706433/` and `http://0x7f000001/` both arrive here as `127.0.0.1`), and
 * it puts userinfo where it belongs — `http://127.0.0.1@evil.test/` has hostname
 * `evil.test`, so the oldest trick in this family is answered by asking the parser
 * rather than by matching the string.
 *
 * The whole 127.0.0.0/8 block counts, not just `.1`: binding a second local backend on
 * `127.0.0.2` is an ordinary thing to do and there is no reason to refuse it. Anything
 * this does not recognise — a trailing-dot FQDN, an IPv4-mapped IPv6 literal — is
 * REFUSED rather than guessed at. Refusing falls back to the chosen environment, so the
 * cost of being wrong in that direction is an inconvenience, and in the other it is a
 * prompt leaving the machine.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // A trailing dot is the same name, absolutely qualified.
  if (host.endsWith(".") && LOOPBACK_HOSTS.has(host.slice(0, -1))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/**
 * The backend endpoint for a spawned engine or CLI command.
 *
 * `environment` is the stored settings choice; `raw` is `DAINTREE_BACKEND_URL`. The
 * variable wins when it is present AND loopback, so a developer running a backend on
 * another port does not have to touch Settings to use it. Everything else resolves to
 * the chosen environment's own URL.
 *
 * A rejected variable falls back rather than failing the launch. The assistant still
 * works, on the backend the user actually chose, and the reason is on the console —
 * which is the right trade for a value nobody deliberately aimed anywhere.
 *
 * A blank value is treated as ABSENT rather than passed through. The engine reads an
 * empty `DAINTREE_BACKEND_URL` as unset and falls through to its own stored preference
 * and then to its deployed default, so forwarding `""` would quietly undo the choice —
 * and do it on the one input a shell most easily produces.
 */
export function resolveBackendUrl(
  raw: string | undefined,
  environment?: AssistantBackendEnvironment
): string {
  const chosen = assistantBackendEnvironment(environment).url;
  const trimmed = raw?.trim();
  if (!trimmed) return chosen;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Unparseable is not a deliberate override — it is a typo, and passing it through
    // lands the engine on its own deployed default, which is the one outcome to avoid.
    console.warn(
      `[assistant-host] Ignoring unparseable DAINTREE_BACKEND_URL ${JSON.stringify(trimmed)}; using ${chosen}.`
    );
    return chosen;
  }
  if (!isLoopbackHost(parsed.hostname)) {
    console.warn(
      `[assistant-host] DAINTREE_BACKEND_URL points off-box (${parsed.hostname}); the variable can only move the endpoint within loopback. Choose an environment in Settings instead. Using ${chosen}.`
    );
    return chosen;
  }
  // The NORMALISED serialisation, not the string we were handed.
  //
  // Two runtimes read this value and they do not agree on the exotic spellings.
  // `http://2130706433/` is loopback to the WHATWG parser used above, which resolves it
  // to 127.0.0.1 — but Go's `net.ParseIP` does not recognise the decimal form at all, so
  // the engine's own "is this loopback?" check says no and its client is free to send
  // the request through an inherited `HTTP_PROXY`. Validated here, refused off-box, and
  // then quietly proxied off-box anyway. Handing on the canonical form closes that gap:
  // both parsers see the same address.
  return parsed.href;
}
