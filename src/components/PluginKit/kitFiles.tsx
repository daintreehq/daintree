import type { PluginFileRejection } from "@shared/types/plugin-sdk-react";
import { pluralize } from "@/lib/pluralize";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";

/** `accept` as `<input type="file">` reads it: extensions, `type/*` and exact MIME types. */
export function fileMatchesAccept(file: { name: string; type: string }, accept?: string): boolean {
  const tokens = (accept ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const fileName = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return tokens.some((token) =>
    token.startsWith(".")
      ? fileName.endsWith(token)
      : token.endsWith("/*")
        ? type.startsWith(token.slice(0, -1))
        : type === token
  );
}

/**
 * The files a control takes from a drop, paste or pick, and every other one
 * with its reason, in the order they came. `limit` caps how many it takes.
 */
export function sortFiles(
  files: readonly File[],
  accept: string | undefined,
  limit = Number.POSITIVE_INFINITY
): { kept: File[]; rejections: PluginFileRejection[] } {
  const kept: File[] = [];
  const rejections: PluginFileRejection[] = [];
  for (const file of files) {
    if (!fileMatchesAccept(file, accept)) {
      rejections.push({ file, reason: "type-not-accepted" });
    } else if (kept.length >= limit) {
      rejections.push({ file, reason: "too-many-files" });
    } else {
      kept.push(file);
    }
  }
  return { kept, rejections };
}

function named(files: readonly PluginFileRejection[]): string {
  return files.length <= 2
    ? files.map((entry) => entry.file.name || "a file").join(" and ")
    : pluralize(files.length, "file");
}

/** One line per reason, naming what was skipped: what the host says when the plugin doesn't. */
export function skippedFilesLines(rejections: readonly PluginFileRejection[]): string[] {
  const refused = rejections.filter((entry) => entry.reason === "type-not-accepted");
  const extra = rejections.filter((entry) => entry.reason === "too-many-files");
  return [
    refused.length > 0 ? `Skipped ${named(refused)}: not an accepted file type` : null,
    extra.length > 0 ? `Skipped ${named(extra)}: one file at a time` : null,
  ].filter((line): line is string => line !== null);
}

const WarningGlyph = SEVERITY_GLYPH.warning;

/**
 * The host's own note of what an intake skipped: files a plugin has no
 * `onReject` for, pasted lines past a cap.
 */
export function SkippedNote({
  lines,
  className,
}: {
  lines: readonly string[];
  className?: string;
}) {
  if (lines.length === 0) return null;
  return (
    <div role="alert" data-skipped-files="" className={cn("grid gap-1", className)}>
      {lines.map((line) => (
        <p key={line} className="m-0 flex items-start gap-1.5 text-left text-xs text-text-primary">
          <WarningGlyph aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning" />
          <span className="min-w-0 break-words">{line}</span>
        </p>
      ))}
    </div>
  );
}
