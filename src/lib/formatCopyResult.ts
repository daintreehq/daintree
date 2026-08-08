import { formatBytes } from "@/lib/formatBytes";

/**
 * The one-line summary shown after a CopyTree bundle lands on the clipboard.
 *
 * Lives here rather than beside its original caller in `useWorktreeActions`
 * because the copyTree action definitions need it too, and that hook imports
 * `actionService` — importing it from an action definition would close a cycle
 * (`ActionService` → definitions → hook → `ActionService`). This module is a
 * leaf over `formatBytes`, so both sides can depend on it (#11722).
 */
export function formatCopyResultMessage(payload: {
  fileCount: number;
  stats?: { totalSize?: number } | null;
  format?: string;
}): string {
  const fileCount =
    typeof payload.fileCount === "number" && Number.isFinite(payload.fileCount)
      ? payload.fileCount
      : 0;
  const stats = payload.stats ?? undefined;
  const sizeStr = stats?.totalSize ? formatBytes(stats.totalSize) : "";
  const formatStr = payload.format ? ` as ${payload.format.toUpperCase()}` : "";
  return `Copied ${fileCount} files${sizeStr ? ` (${sizeStr})` : ""}${formatStr} to clipboard`;
}
