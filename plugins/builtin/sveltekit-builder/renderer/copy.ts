import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { SitePreviewDetachReason } from "@shared/types/ipc/sitePreview";
import type { SelectionMismatch } from "../shared/protocol.js";
import type { StaleReason } from "./inspectorController.js";

/**
 * One voice: every reason opens with the action, then says why. Two of these
 * used to lead with the cause and two with the remedy, so the same panel state
 * read as two different conditions depending on how it was reached.
 */
export const STALE_COPY: Record<StaleReason, { title: string; detail: string }> = {
  "document-changed": {
    title: "Select again — the page reloaded",
    detail: "This selection no longer points at a live element.",
  },
  "source-changed": {
    title: "Select again — the file changed",
    detail: "The source behind this element changed after you selected it.",
  },
  "preview-detached": {
    title: "Select again — the preview disconnected",
    detail: "This selection came from a preview that's no longer connected.",
  },
};

export const DETACH_COPY: Record<SitePreviewDetachReason, string> = {
  requested: "Disconnected from the dev preview",
  "guest-destroyed": "The dev preview was closed",
  rebound: "Another inspector connected to this preview",
  "install-failed": "Couldn't start the inspector inside the preview",
  "debugger-detached": "Disconnected — DevTools may have taken over the preview",
  "guest-flooding": "Disconnected — the page sent too many invalid messages",
  "owner-disabled": "Disconnected — the Site Builder plugin was switched off",
  "host-shutdown": "Disconnected from the dev preview",
};

/**
 * The strip while the preview shows a page outside the builder's origins — an
 * external site the app linked to, an OAuth provider. Says what the host
 * checked, the address, not who served it (a tunnel or a custom domain in
 * front of the same dev server reads as foreign too). An observation with
 * nothing to do: the binding is intact and the next local page picks up on
 * its own, so no action and no warning tone.
 */
export const ORIGIN_SUSPENDED_COPY = "Paused — this page isn't at a local address";

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function displayUrl(url: string | null): string {
  if (!url) return "No page loaded";
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.hash}` || "/";
  } catch {
    return url;
  }
}

export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function relativeTo(root: string | null, path: string): string {
  if (!root) return path;
  const base = root.replace(/\/+$/, "");
  if (path === base) return ".";
  return path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
}

/**
 * What to show the user when a call to plugin main fails.
 *
 * A schema mismatch — a plugin and a host that disagree about the wire, which
 * is what a partial upgrade looks like — arrives here as a `ZodError`, and its
 * `.message` is the raw issue array: `[{"code":"invalid_union","discriminator":
 * "status","options":["ready","ambiguous","no-app"], …}]`. That was being
 * rendered verbatim as the panel's explanation, wrapped across eight lines of
 * proportional type. It tells the user nothing they can act on and reads as a
 * crash.
 *
 * A validation failure is ours, not the user's project's, so it gets a sentence
 * that says so. Everything else is a real runtime error (EACCES, ENOENT) whose
 * message is genuinely useful, and keeps it.
 */
export function wireFailureMessage(error: unknown, fallback: string): string {
  if (isSchemaError(error)) {
    return "The Site Builder and this version of Daintree disagree about the response format. Restarting the app usually clears it.";
  }
  return formatErrorMessage(error, fallback);
}

/**
 * Structural, not `instanceof`: zod may be duplicated across the plugin and host
 * bundles, and a cross-realm `instanceof ZodError` is false exactly when this
 * guard matters most.
 */
function isSchemaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "ZodError" || name === "$ZodError") return true;
  return Array.isArray((error as { issues?: unknown }).issues);
}

/**
 * A location the page reported that the file contradicts, with no change to
 * the file to explain it. Said as what was seen — the page's claim and the
 * file's answer — because the one thing this must not be is "the page
 * changed": nothing did, and clicking again gives the same answer. The known
 * way here is a server-rendered page: Svelte's dev build tags an element with
 * a neighbour's location when a child component's root precedes it in the
 * same template (its `add_locations` counts that root while hydrating), and a
 * client-side navigation re-renders the page without that — which needs
 * Browse mode, since Select mode keeps the page's links from navigating.
 */
export function mismatchMessage(mismatch: SelectionMismatch): string {
  const where = `${mismatch.file}:${mismatch.line}:${mismatch.column}`;
  const found =
    mismatch.found === null
      ? "no element starts there"
      : `the file has a <${mismatch.found}> there`;
  return (
    `The page places this <${mismatch.reported}> at ${where}, but ${found}. ` +
    "A server-rendered page can report a neighbour's location — switch to Browse, " +
    "open this page from a link inside the preview, then select the element again."
  );
}

/**
 * What the support verdict is allowed to say, in one voice for the two places
 * that say it: the drawer and the agent prompt.
 *
 * It is an observation about our bundled compiler, never a limitation of the
 * user's app — tracing an element and handing it to an agent work the same
 * either way — so it stays at the lowest signal tier: neutral, no accent, no
 * action, and nothing about what the builder won't do.
 */
export const UNTESTED_TOOLCHAIN_TITLE = "Toolchain not verified";

/** The drawer's body: the verdict's own reasons, which already name the package and version. */
export function untestedToolchainDetail(reasons: readonly string[]): string {
  return reasons.join(". ");
}

/**
 * The prompt's line. The agent has the versions listed above it already, so
 * this says the one thing they don't carry: which of them sit outside the
 * majors the bundled compiler was tested against.
 */
export function untestedToolchainPromptLine(notes: readonly string[]): string {
  return `- Toolchain note: ${notes.join("; ")} — the referenced locations come from a compiler tested against other majors, so verify the source before relying on them`;
}
