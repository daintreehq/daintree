import type { SitePreviewDetachReason } from "@shared/types/ipc/sitePreview";
import type { EditSupport, UnsupportedReason } from "../shared/model.js";
import type { StaleReason } from "./inspectorController.js";

export const UNSUPPORTED_REASON_COPY: Record<UnsupportedReason, string> = {
  "dynamic-expression": "Set by an expression in the source, not a literal value",
  "class-directive": "Controlled by a class: directive",
  "spread-attribute": "Comes from spread attributes",
  "data-driven": "Comes from data at runtime, not from source",
  "snippet-supplied": "Supplied by a snippet from the parent component",
  "dependency-owned": "Defined in a dependency, not in this project",
  "generated-file": "Defined in a file SvelteKit generates",
  "ambiguous-invocation": "More than one call site could have drawn this element",
  "unmapped-content": "Couldn't be traced back to source",
  "unsupported-framework-version": "This Svelte or SvelteKit version isn't supported for editing",
};

export const SUPPORT_LABEL: Record<EditSupport, string> = {
  direct: "Editable",
  "agent-assisted": "Needs an agent",
  "inspect-only": "Inspect only",
};

export const STALE_COPY: Record<StaleReason, { title: string; detail: string }> = {
  "document-changed": {
    title: "Selection changed — select again",
    detail: "The page reloaded, so this selection no longer points at a live element.",
  },
  "source-changed": {
    title: "Source changed — select again",
    detail: "The file behind this element changed after you selected it.",
  },
  edited: {
    title: "Select again to keep editing",
    detail: "The saved change moved this element's source.",
  },
  "preview-detached": {
    title: "Preview disconnected — select again",
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
