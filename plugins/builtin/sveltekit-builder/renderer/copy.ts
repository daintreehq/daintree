import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { SitePreviewDetachReason } from "@shared/types/ipc/sitePreview";
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
  edited: {
    // Not "moved": an equal-length replacement moves nothing. What is true is
    // that the positions this selection was read from predate the write.
    title: "Saved — select again to keep editing",
    detail: "This selection was read before the write; select the element again to refresh it.",
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
  "host-shutdown": "Disconnected from the dev preview",
};

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
