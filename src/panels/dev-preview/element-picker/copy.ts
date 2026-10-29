import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { SitePreviewDetachReason } from "@shared/types/ipc/sitePreview";
import type { ElementPickerProviderId } from "@shared/elementPicker";
import type { StaleReason, WorkspaceFailure } from "./inspectorController.js";

/**
 * One formula for every pick the user has to make again, wherever it is said
 * and however it was reached: what happened, then "select it again". The
 * strip says the headline; the drawer adds the one sentence of why.
 */
export const SELECT_AGAIN = {
  pageReloaded: "Page reloaded — select it again",
  fileChanged: "File changed — select it again",
  previewDetached: "Preview disconnected — select it again",
  pageChanged: "Page changed — select it again",
  pageLoading: "Page still loading — select it again",
} as const;

export const STALE_COPY: Record<StaleReason, { title: string; detail: string }> = {
  "document-changed": {
    title: SELECT_AGAIN.pageReloaded,
    detail: "This selection no longer points at a live element.",
  },
  "source-changed": {
    title: SELECT_AGAIN.fileChanged,
    detail: "Its source changed after you selected it.",
  },
  "preview-detached": {
    title: SELECT_AGAIN.previewDetached,
    detail: "It came from a preview that's no longer connected.",
  },
};

/**
 * What Send's note says while the page is being asked for the element again:
 * the drawer is deliberately silent then, because "select it again" would be
 * withdrawn a moment later, so the note says what is happening instead.
 */
export const REPROVING_NOTE = "Checking this selection again";

/**
 * A picked component whose file wasn't found, said by the identity's path slot
 * and by the note under Send in one voice. The slot sits under a header that
 * names the component; the note names it, because the Target control can
 * point the composer at a different one than the identity describes.
 */
export function missingComponentSource(label?: string): string {
  return label ? `Couldn't find the source for ${label}` : "Couldn't find the source";
}

/** The selection outcomes that end without a selection, as headline and reason. */
export const SELECTION_OUTCOME_COPY = {
  settled: {
    title: SELECT_AGAIN.fileChanged,
    detail:
      "The preview may still show the old version. Wait for it to update, then click the element.",
  },
  lost: {
    title: SELECT_AGAIN.pageChanged,
    detail: "It changed while the source was being found.",
  },
  loading: { title: SELECT_AGAIN.pageLoading },
  mismatch: {
    title: "Reported location doesn't match the file",
    detail:
      "Server-rendered pages can do this. In Browse, follow a link inside the preview to this page, then switch to Inspect and select it again.",
  },
  host: {
    title: "Couldn't find this element's source",
    detail: "Click the element to try again.",
  },
} as const;

/**
 * Why the site source couldn't be opened, as the strip's one line and the
 * drawer's headline. Each names what happened in the user's terms; the way
 * forward sits beside it in the drawer, and only a read error is retried.
 */
export const WORKSPACE_FAILURE_COPY: Record<WorkspaceFailure, { strip: string; title: string }> = {
  "read-error": {
    strip: "Couldn't read the site source",
    title: "Couldn't read the site source",
  },
  "invalid-app": {
    strip: "The chosen app is gone from this worktree",
    title: "That app is gone from this worktree",
  },
  "unknown-worktree": {
    strip: "This worktree isn't open in the project",
    title: "This worktree isn't open in the project",
  },
  "other-worktree": {
    strip: "The dev server runs from another worktree",
    title: "The dev server runs from another worktree",
  },
};

/** The modes, as every surface and message says them: the control's own labels. */
export { TOOL_NAME } from "./toolId.js";
export const BROWSE_COPY = "Browsing — switch to Inspect to pick an element";
export const INSPECT_IDLE_COPY = "Click an element to ask an agent about it";

export const DETACH_COPY: Record<SitePreviewDetachReason, string> = {
  requested: "Disconnected from the dev preview",
  "guest-destroyed": "The dev preview was closed",
  rebound: "Another Element Picker took over this preview",
  "install-failed": "Couldn't start the Element Picker inside the page",
  "debugger-detached": "Disconnected — DevTools may have taken over the preview",
  "guest-flooding": "Disconnected — the page sent too many invalid messages",
  // Unreachable in practice: the view this would be addressed to is the one
  // that went away. Present because the reason is part of the wire contract.
  "subscriber-destroyed": "Disconnected from the dev preview",
  "host-shutdown": "Disconnected from the dev preview",
};

/**
 * The strip while the preview shows a page outside the picker's origins — an
 * external site the app linked to, an OAuth provider. Says what the host
 * checked, the address, not who served it (a tunnel or a custom domain in
 * front of the same dev server reads as foreign too). An observation with
 * nothing to do: the binding is intact and the next local page picks up on
 * its own, so no action and no warning tone.
 */
export const ORIGIN_SUSPENDED_COPY = "Paused — this page isn't at a local address";

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
 * What to show the user when a call to the source host fails.
 *
 * A schema mismatch — two halves that disagree about the wire, which is what a
 * partial upgrade looks like — arrives here as a `ZodError`, whose `.message`
 * is the raw issue array. Rendered verbatim it reads as a crash and tells the
 * user nothing they can act on. A validation failure is ours, not the user's
 * project's, so it gets a sentence that says so. Everything else is a real
 * runtime error (EACCES, ENOENT) whose message is genuinely useful, and keeps it.
 */
export function wireFailureMessage(error: unknown, fallback: string): string {
  if (isSchemaError(error)) {
    return "The Element Picker and this version of Daintree disagree about the response format. Restarting the app usually clears it.";
  }
  return formatErrorMessage(error, fallback);
}

/**
 * Structural, not `instanceof`: zod may be duplicated across bundles, and a
 * cross-realm `instanceof ZodError` is false exactly when this guard matters
 * most.
 */
function isSchemaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "ZodError" || name === "$ZodError") return true;
  return Array.isArray((error as { issues?: unknown }).issues);
}

/**
 * A location the page reported that the file contradicts, with no change to
 * the file to explain it. Said as what was seen — the page's claim, and that
 * the file doesn't hold it — because the one thing this must not be is "the
 * page changed": nothing did, and clicking again gives the same answer. The
 * known way here is a server-rendered page: Svelte's dev build tags an element
 * with a neighbour's location when a child component's root precedes it in the
 * same template, and a client-side navigation re-renders the page without that
 * — which needs Browse mode, since Inspect mode keeps the page's links from
 * navigating. The way out is `SELECTION_OUTCOME_COPY.mismatch`, beside this.
 */
export function mismatchMessage(reported: { tagName: string; file: string; line: number }): string {
  return `The page places this <${reported.tagName.toLowerCase()}> at ${reported.file}:${reported.line}, but the file doesn't hold it there.`;
}

const FRAMEWORK_NAMES: Readonly<Record<string, string>> = {
  svelte: "Svelte",
  react: "React",
  vue: "Vue",
  angular: "Angular",
  astro: "Astro",
  preact: "Preact",
  solid: "Solid",
};

/**
 * The page's own verdict on itself, as the drawer says it. The guest's words
 * stay out of it: they are written for a log, and "envelope" or a raw
 * `TypeError` is not a sentence the user can act on. Capacity is two
 * different outcomes under one code — a pick that was cut down to fit, and one
 * refused outright — and the guest's (bootstrap-worded, never page-written)
 * detail is what tells them apart.
 */
export function runtimeIssueMessage(
  code: string,
  framework: ElementPickerProviderId | undefined,
  detail = ""
): { title: string; body?: string } | null {
  const name = framework ? FRAMEWORK_NAMES[framework] : null;
  switch (code) {
    case "not-dev-build":
      return {
        title: "Production build — elements can't be traced to source",
        body: "Run the app's dev server to trace elements to their files.",
      };
    case "metadata-unavailable":
      return {
        title: name
          ? `No ${name} source locations on this page`
          : "No source locations on this page",
      };
    case "overlay-blocked":
      return { title: "The page blocked the selection outline" };
    case "capacity":
      if (detail.startsWith("selection left unchanged")) {
        return {
          title: "That element is too large to select",
          body: "The previous selection is still the one a request is about.",
        };
      }
      return detail.includes("markup and styles")
        ? {
            title: "Part of this selection was left out",
            body: "Its outer components, markup and styles were too large to keep.",
          }
        : {
            title: "Outer components were left out",
            body: "The component chain was too long to keep whole. The element itself is complete.",
          };
    case "extractor-failed":
      return {
        title: name
          ? `Couldn't read this page's ${name} components`
          : "Couldn't read this page's components",
      };
    case "internal":
      return { title: "The Element Picker hit a problem inside the page" };
    default:
      return null;
  }
}

/** Page verdicts whose guest detail is a diagnostic worth showing, not a restatement. */
export function issueDetailIsDiagnostic(code: string | undefined): boolean {
  return code === "internal" || code === "extractor-failed" || code === undefined;
}

/** Page verdicts that already say an element can't be traced; the identity doesn't say it again. */
export function issueSaysUntraced(code: string | undefined): boolean {
  return code === "not-dev-build" || code === "metadata-unavailable" || code === "extractor-failed";
}

/**
 * What the support verdict is allowed to say, in one voice for the two places
 * that say it: the drawer and the agent prompt.
 *
 * It is an observation about our bundled compiler, never a limitation of the
 * user's app — tracing an element and handing it to an agent work the same
 * either way — so it stays at the lowest signal tier: neutral, no accent, no
 * action, and nothing about what the picker won't do.
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
