import { formatBytes } from "@/lib/formatBytes";
import type { CopyTreeBudgetStats, CopyTreeExclusionReason } from "@shared/types/ipc/copyTree";

/**
 * Where a CopyTree bundle landed. The verb has to match the destination —
 * `copyTree.generate` writes a temp file and never touches the clipboard, so
 * reporting it as "copied … to clipboard" would be plainly false (#11735).
 */
export type CopyResultDestination = "clipboard" | "terminal" | "temporary-file";

export interface CopyResultSummary {
  fileCount: number;
  stats?: { totalSize?: number } | null;
  format?: string;
}

/** Verb + trailing phrase per destination. */
const DESTINATION_WORDING: Record<CopyResultDestination, { verb: string; suffix: string }> = {
  clipboard: { verb: "Copied", suffix: " to clipboard" },
  terminal: { verb: "Injected", suffix: " into terminal" },
  "temporary-file": { verb: "Bundled", suffix: " into a temporary file" },
};

/**
 * The one-line summary shown after a CopyTree bundle lands.
 *
 * Lives here rather than beside its original caller in `useWorktreeActions`
 * because the copyTree action definitions need it too, and that hook imports
 * `actionService` — importing it from an action definition would close a cycle
 * (`ActionService` → definitions → hook → `ActionService`). This module is a
 * leaf over `formatBytes`, so both sides can depend on it (#11722).
 *
 * `destination` defaults to "clipboard" so the pre-existing callers read the
 * same as they always did.
 */
export function formatCopyResultMessage(
  payload: CopyResultSummary,
  destination: CopyResultDestination = "clipboard"
): string {
  const fileCount =
    typeof payload.fileCount === "number" && Number.isFinite(payload.fileCount)
      ? payload.fileCount
      : 0;
  const stats = payload.stats ?? undefined;
  const sizeStr = stats?.totalSize ? formatBytes(stats.totalSize) : "";
  const formatStr = payload.format ? ` as ${payload.format.toUpperCase()}` : "";
  const { verb, suffix } = DESTINATION_WORDING[destination];
  return `${verb} ${fileCount} files${sizeStr ? ` (${sizeStr})` : ""}${formatStr}${suffix}`;
}

/**
 * Reasons that mean "a rule the project already lives by kept this out", as
 * opposed to a limit the user set in Daintree's own context settings. Only
 * used to explain a zero-file folder copy — the SDK's `scopeFilter` reason is
 * declared but never emitted, so nothing may wait on it.
 */
const IGNORE_RULE_REASONS: CopyTreeExclusionReason[] = [
  "gitignore",
  "copytreeignore",
  "globalGitignore",
  "gitInfoExclude",
  "configExclude",
];

/**
 * Why a folder copy came back empty. Without this the toast reports "Copied 0
 * files", which reads as a failure for the common case of right-clicking a
 * folder that the project ignores wholesale (`node_modules`, `dist`).
 *
 * Lives in this leaf module alongside `formatCopyResultMessage` so the action
 * definitions can explain a scoped zero-file result too, not just the
 * context-menu path that first needed it (#11735).
 */
export function describeEmptyFolderCopy(stats?: CopyTreeBudgetStats | null): string {
  const byReason = stats?.excluded?.byReason;
  const total = stats?.excluded?.total ?? 0;

  if (total <= 0) {
    return "This folder doesn't contain any files";
  }

  // Nothing was ruled out — the files couldn't be opened at all, which usually
  // means the folder moved or its permissions changed since the tree was read.
  if ((byReason?.unreadable ?? 0) === total) {
    return "The files in this folder couldn't be read";
  }

  const ignored = IGNORE_RULE_REASONS.reduce((sum, reason) => sum + (byReason?.[reason] ?? 0), 0);

  // Only claim a single cause when it accounts for every exclusion; a mixed set
  // gets the neutral wording rather than a confident half-truth.
  return ignored === total
    ? "Every file in this folder is excluded by an ignore rule"
    : "Every file in this folder was excluded by ignore rules or context settings";
}
