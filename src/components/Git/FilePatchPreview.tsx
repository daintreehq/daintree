import { Fragment, type ReactNode } from "react";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { cn } from "@/lib/utils";

type PatchRowKind = "hunk" | "add" | "del" | "context";

interface PatchRow {
  kind: PatchRowKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The text of a diff that only creates a file — a new file, a copy — or null
 * for any other diff. Such a diff is the file itself, so the confirm shows it
 * as contents rather than as a column of additions.
 */
export function newFileText(patch: string): string | null {
  const rows = parsePatchRows(patch);
  const hunks = rows.filter((row) => row.kind === "hunk");
  if (hunks.length !== 1 || hunks[0]!.oldLine !== 0) return null;
  if (rows.some((row) => row.kind === "del" || row.kind === "context")) return null;
  return rows
    .filter((row) => row.kind === "add")
    .map((row) => `${row.text}\n`)
    .join("");
}

/**
 * The hunks of a unified diff as rows with both line numbers. File headers and
 * git's metadata are dropped — the confirm names the file already — and so is
 * `\ No newline at end of file`, which is a note about a line, not a line.
 */
export function parsePatchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of splitLines(patch)) {
    if (line.startsWith("diff ")) {
      inHunk = false;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      rows.push({ kind: "hunk", oldLine, newLine, text: "" });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldLine: null, newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldLine++, newLine: null, text: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    }
  }
  return rows;
}

function textRows(text: string): PatchRow[] {
  return splitLines(text).map((line, i) => ({
    kind: "context",
    oldLine: null,
    newLine: i + 1,
    text: line,
  }));
}

// The diff workspace's reading: code keeps neutral ink, the row carries the
// tint, and the sign is the non-colour channel in full-contrast ink.
const ROW_CLASS: Record<Exclude<PatchRowKind, "hunk">, string> = {
  add: "bg-diff-insert-background",
  del: "bg-diff-delete-background",
  context: "",
};

const SIGN: Record<Exclude<PatchRowKind, "hunk">, string> = { add: "+", del: "-", context: " " };

const GUTTER_CLASS = "w-9 shrink-0 pr-1.5 text-right tabular-nums text-text-secondary select-none";

/** A diff to show as hunks, or a file's own text to show as numbered lines. */
export type PreviewSection =
  { kind: "patch"; label: string; patch: string } | { kind: "text"; label: string; text: string };

/**
 * The lines a file mutation would act on, in a bounded region.
 *
 * The region has no focusable children, so it takes focus itself (WCAG 2.1.1)
 * and carries a name; the edge fades say there is more. Lines wrap rather than
 * scroll sideways — a preview is read, not navigated — and a wrapped line
 * keeps its indentation under the code column.
 */
export function FilePatchPreview({
  sections,
  label,
  footer,
}: {
  sections: PreviewSection[];
  /** The region's accessible name. */
  label: string;
  /** A closing line under the rows: where the preview stops, and why. */
  footer?: ReactNode;
}) {
  const showLabels = sections.length > 1;
  return (
    <ScrollShadow
      className="max-h-64"
      scrollClassName="scroll-py-6 focus-visible:-outline-offset-2"
      tabIndex={0}
      role="region"
      aria-label={label}
      data-testid="file-mutation-preview-lines"
    >
      <div className="py-1.5 font-mono text-2xs leading-[1.6] text-text-primary">
        {sections.map((section) => {
          const isPatch = section.kind === "patch";
          const rows = isPatch ? parsePatchRows(section.patch) : textRows(section.text);
          return (
            <Fragment key={section.label}>
              {showLabels && (
                <div className={cn(LIST_LABEL_CLASS, "px-3 pt-1.5 pb-1 font-sans first:pt-0.5")}>
                  {section.label}
                </div>
              )}
              {rows.map((row, i) =>
                row.kind === "hunk" ? (
                  // Git's hunk header also names the nearest "function" line,
                  // which for most files is just some earlier line — set beside
                  // a line number it read as that line's content. The number
                  // alone says where the hunk starts.
                  <div
                    key={i}
                    className="px-3 py-0.5 font-sans text-text-secondary bg-overlay-subtle"
                  >
                    Line {row.newLine ?? row.oldLine}
                  </div>
                ) : (
                  <div key={i} className={cn("flex", ROW_CLASS[row.kind])}>
                    {isPatch && (
                      <span aria-hidden="true" className={GUTTER_CLASS}>
                        {row.oldLine ?? ""}
                      </span>
                    )}
                    <span aria-hidden="true" className={GUTTER_CLASS}>
                      {row.newLine ?? ""}
                    </span>
                    {isPatch && (
                      <span aria-hidden="true" className="w-4 shrink-0 text-center select-none">
                        {SIGN[row.kind]}
                      </span>
                    )}
                    {row.kind !== "context" && (
                      <span className="sr-only">
                        {row.kind === "add" ? "Added: " : "Removed: "}
                      </span>
                    )}
                    <span
                      className={cn(
                        "min-w-0 flex-1 pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]",
                        !isPatch && "pl-2"
                      )}
                    >
                      {row.text === "" ? " " : row.text}
                    </span>
                  </div>
                )
              )}
            </Fragment>
          );
        })}
        {footer && (
          <div className="px-3 pt-1.5 font-sans text-2xs text-text-secondary">{footer}</div>
        )}
      </div>
    </ScrollShadow>
  );
}
