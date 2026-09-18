/**
 * Where a guest adapter may run.
 *
 * A dev preview can navigate. "This panel started on localhost" says nothing
 * about the document it shows a minute later — an OAuth hop, a link to the
 * production site, a redirect — and the runtime the host installs is code that
 * reads the page's DOM and talks back over a CDP binding. An adapter therefore
 * declares the origins it is for, and the bridge checks the guest's URL on
 * every install: at bind, and again on each committed navigation.
 */

export type GuestOriginPolicy =
  /** Loopback, `*.localhost`, `*.local` and RFC 1918 addresses: a dev server. */
  | "local-preview"
  /** Any document the preview shows. */
  | "any";

export const DEFAULT_GUEST_ORIGIN_POLICY: GuestOriginPolicy = "local-preview";

/**
 * Whether a document at `url` counts as a local preview. An empty URL and the
 * pages a preview shows before any site loads are local: there is nothing
 * there yet, and installing on them is what puts the runtime in place for the
 * dev server's first document.
 */
export function isLocalPreviewUrl(url: string | null | undefined): boolean {
  return evaluateOriginPolicy("local-preview", url ?? "");
}

export function originPolicyAllows(
  policy: GuestOriginPolicy,
  url: string | null | undefined
): boolean {
  return evaluateOriginPolicy(policy, url ?? "");
}

/**
 * The policy again, as one function that closes over nothing.
 *
 * It exists in this shape so it can be serialised into the guest with
 * `toString()` — the host cannot install a script and then check the origin,
 * because `Page.addScriptToEvaluateOnNewDocument` has already run by the time a
 * navigation is observed, so the check has to travel with the script. Copying
 * the rules into a string literal would let the page's copy and this one drift;
 * shipping this exact function cannot.
 *
 * Everything it needs is inlined for that reason, and it must stay that way: a
 * reference to anything outside its own body is `undefined` in the page.
 * {@link originPolicyAllows} and {@link isLocalPreviewUrl} are its host-side
 * readings, so the tests that cover them cover what the guest runs.
 *
 * It is not tamper-proof, and is not meant to be. It runs in the page's main
 * world, so a hostile document can replace `URL` and make it answer either way
 * — deny, which silences its own inspector, or allow, which puts it back where
 * it was before this existed. That is why the host's own check stays
 * authoritative: this closes the timing gap for an ordinary navigation, which
 * is what an OAuth hop or an external link actually is, and the host is what
 * removes the script and disposes the runtime regardless.
 */
function evaluateOriginPolicy(policy: string, url: string): boolean {
  if (policy === "any") return true;
  if (!url) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Schemes a preview shows before, or instead of, a site. Nothing to protect.
  if (parsed.protocol === "about:" || parsed.protocol === "chrome-error:") return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host === "[::1]" || host === "[::]") return true;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    octets.push(n);
  }
  if (octets[0] === 127 || host === "0.0.0.0") return true;
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  for (const [a, b, c, d, bits] of [
    [10, 0, 0, 0, 8],
    [172, 16, 0, 0, 12],
    [192, 168, 0, 0, 16],
  ]) {
    const network = ((a! << 24) | (b! << 16) | (c! << 8) | d!) >>> 0;
    const mask = (0xffffffff << (32 - bits!)) >>> 0;
    if ((value & mask) === (network & mask)) return true;
  }
  return false;
}

/**
 * The policy as an expression the guest evaluates against its own document,
 * for the host to place at the very top of the injected script. `true` means
 * the script may go on to install itself.
 */
export function buildOriginGuardSource(policy: GuestOriginPolicy): string {
  return `(${evaluateOriginPolicy.toString()})(${JSON.stringify(policy)}, location.href)`;
}
