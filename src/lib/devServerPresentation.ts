import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import type { DevServerError } from "@shared/utils/devServerErrors";

export function portFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).port || null;
  } catch {
    return null;
  }
}

/**
 * `Cannot find module '…'` captures whatever was quoted, which is often a
 * relative or absolute file path rather than a package; only a bare package
 * name is short and safe enough to repeat.
 */
function isPackageName(module: string): boolean {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(module) && module.length <= 48;
}

/**
 * One line on why a dev server failed, short enough for a tooltip. The full
 * message stays in the dev preview: for `unknown` it can be a raw spawn error
 * with absolute paths, which a row header has no room to explain.
 */
export function devServerFailureReason(error: DevServerError | null): string {
  switch (error?.type) {
    case "port-conflict":
      return error.port ? `Port ${error.port} is already in use` : "Its port is already in use";
    case "missing-dependencies":
      return error.module && isPackageName(error.module)
        ? `Missing dependency ${error.module}`
        : "Missing dependencies";
    case "permission":
      return "Permission denied";
    case "compile-error":
      return "Compilation failed";
    case "oom":
      return "Ran out of memory";
    case "process-crash":
      return "The process crashed";
    default:
      return "Stopped with an error";
  }
}

export interface DevServerSummary {
  title: string;
  detail: string | null;
}

/**
 * What a worktree's dev server is doing, as the row's tooltip and its
 * keyboard description both say it. Null for a session with no live server.
 */
export function summarizeDevServer(session: DevPreviewSessionState): DevServerSummary | null {
  switch (session.status) {
    case "running":
      return { title: "Dev server running", detail: session.url };
    case "starting":
      return { title: "Starting dev server", detail: session.predictedUrl };
    case "installing":
      return { title: "Installing dependencies", detail: null };
    case "error":
      return { title: "Dev server failed", detail: devServerFailureReason(session.error) };
    default:
      return null;
  }
}

export function devServerSummaryText(summary: DevServerSummary): string {
  return summary.detail ? `${summary.title}: ${summary.detail}` : summary.title;
}
