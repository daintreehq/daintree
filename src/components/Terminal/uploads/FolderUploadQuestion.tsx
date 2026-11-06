import { File, Folder } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { PathSegments } from "@/components/ui/PathSegments";
import { TitleEntity } from "@/components/ui/TitleEntity";
import {
  PreviewFrame,
  PreviewNotice,
  PreviewSectionHeading,
  PreviewSummary,
  SummaryRow,
} from "@/components/Git/GitOperationPreview";
import { formatBytes } from "@/lib/formatBytes";
import { pluralize } from "@/lib/pluralize";
import type { FolderUploadTotals } from "@shared/types/folderUpload";
import {
  HOST_INBOX_ENTRY_TTL_MS,
  type FolderNotCopiedReason,
  type FolderSummaryItem,
  type FolderUploadSummary,
} from "@shared/types/ipc/fileTransfer";
import { atLeast, folderRefusal, type FolderRefusal, type RefusalProblem } from "./folderRefusal";
import type { UploadQuestion } from "./uploadConfirm";

type FolderQuestion = Extract<UploadQuestion, { kind: "folder" }>;

/** Rows a list on the question shows before it says how many more there are. */
const LIST_ROWS = 5;

/** Hidden items named beside their count; the rest are in the count. */
const HIDDEN_NAMES = 4;

const INBOX_TTL = pluralize(Math.round(HOST_INBOX_ENTRY_TTL_MS / 3_600_000), "hour");

/** A path inside the dropped folder, without the folder's own name in front. */
function insideFolder(path: string, rootName: string): string {
  const prefix = `${rootName}/`;
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : path;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function contentsText(totals: FolderUploadTotals, lowerBound: boolean): string {
  const parts = [
    pluralize(totals.fileCount, "file"),
    pluralize(totals.folderCount, "folder"),
    formatBytes(totals.totalBytes),
  ].join(" · ");
  return lowerBound ? `At least ${parts}` : parts;
}

const NOT_COPIED_LABEL: Record<FolderNotCopiedReason, string> = {
  symlink: "symbolic link",
  junction: "junction",
  "reparse-point": "reparse point",
  "special-file": "special file",
  unreadable: "can't be read",
};

/** Why the listed items stay behind, said once for each kind present. */
function notCopiedReasons(reasons: ReadonlySet<FolderNotCopiedReason>): string {
  const sentences: string[] = [];
  if (reasons.has("symlink") || reasons.has("junction") || reasons.has("reparse-point")) {
    sentences.push("Links are never followed, so nothing from outside the folder is sent.");
  }
  if (reasons.has("special-file")) sentences.push("Devices, sockets and pipes aren't copied.");
  if (reasons.has("unreadable")) sentences.push("Items this computer can't read are left out.");
  return sentences.join(" ");
}

interface ItemRowData {
  path: string;
  /** Null for an entry that is neither, such as a link whose target is never read. */
  kind: "file" | "folder" | null;
  detail: string | null;
  /** 0..1 of the folder's bytes, or null when the totals can't give an honest share. */
  share: number | null;
}

function shareText(share: number): string {
  const percent = share * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

/** A path as a value: primary ink, mono, wrapping only between folders. */
function PathText({ path }: { path: string }) {
  return (
    <span className="min-w-0 font-mono text-text-primary">
      <span className="sr-only">{path}</span>
      <span aria-hidden="true">
        <PathSegments path={path} />
      </span>
    </span>
  );
}

function ItemRows({ rows, label }: { rows: ItemRowData[]; label: string }) {
  return (
    <ul className="space-y-1.5 px-3 pb-2.5" aria-label={label}>
      {rows.map((row, index) => {
        const Icon = row.kind === "folder" ? Folder : row.kind === "file" ? File : null;
        return (
          // Wraps rather than truncates: at a narrow width the figures drop under
          // the name as one group instead of cutting it, so every name stays whole.
          // Top-aligned, so a name that wraps keeps its glyph and figures on its
          // first line.
          <li key={`${index}:${row.path}`} className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <span className="flex min-w-0 flex-[1_1_8rem] items-start gap-1.5">
              {Icon && (
                <span aria-hidden="true" className="inline-flex h-[1lh] shrink-0 items-center">
                  <Icon className="size-3 text-text-secondary" />
                </span>
              )}
              <PathText path={row.path} />
            </span>
            {(row.detail !== null || row.share !== null) && (
              <span className="ml-auto flex shrink-0 gap-2 tabular-nums">
                {row.detail !== null && <span className="text-text-secondary">{row.detail}</span>}
                {row.share !== null && (
                  <span className="w-9 text-right text-text-primary">{shareText(row.share)}</span>
                )}
              </span>
            )}
            {row.share !== null && (
              <span
                aria-hidden="true"
                className="block h-0.5 basis-full overflow-hidden rounded-full bg-overlay-medium"
              >
                <span
                  className="block h-full rounded-full bg-text-secondary"
                  style={{ width: `${Math.min(1, row.share) * 100}%` }}
                />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function largestRows(summary: FolderUploadSummary): ItemRowData[] {
  const { totals, lowerBound } = summary;
  // A lower bound over a lower bound is no share at all.
  const shares = !lowerBound && totals.totalBytes > 0;
  return summary.largest.slice(0, LIST_ROWS).map((item) => ({
    path: insideFolder(item.path, summary.rootName),
    kind: item.kind,
    detail: atLeast(
      lowerBound,
      item.kind === "folder"
        ? `${pluralize(item.fileCount, "file")} · ${formatBytes(item.totalBytes)}`
        : formatBytes(item.totalBytes)
    ),
    share: shares ? item.totalBytes / totals.totalBytes : null,
  }));
}

/** What a refused folder's listed path adds to the limit it crossed, when the summary knows. */
function contributionText(
  item: FolderSummaryItem | undefined,
  problem: RefusalProblem,
  lowerBound: boolean
): string | null {
  if (!item || problem.kind !== "limit") return null;
  switch (problem.limit) {
    case "files":
      return atLeast(lowerBound, pluralize(item.fileCount, "file"));
    case "folders":
      return atLeast(lowerBound, pluralize(item.folderCount, "folder"));
    case "bytes":
      return atLeast(lowerBound, formatBytes(item.totalBytes));
    // An item's bytes are its files' content, not what it adds to the archive.
    default:
      return null;
  }
}

function HiddenValue({ summary }: { summary: FolderUploadSummary }) {
  const { hidden, rootName, lowerBound } = summary;
  if (hidden.fileCount === 0 && hidden.folderCount === 0) {
    return <span className="text-text-secondary">None</span>;
  }
  const counts = [
    hidden.fileCount > 0 ? pluralize(hidden.fileCount, "file") : null,
    hidden.folderCount > 0 ? pluralize(hidden.folderCount, "folder") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" and ");
  const names = hidden.paths.slice(0, HIDDEN_NAMES).map((path) => insideFolder(path, rootName));
  return (
    <span className="block min-w-0">
      <span className="text-text-primary">
        {capitalize(atLeast(lowerBound, counts))}, copied like the rest
      </span>
      {names.length > 0 && (
        <span className="block break-words text-text-secondary">
          <span className="font-mono">{names.join(", ")}</span>
          {hidden.paths.length > HIDDEN_NAMES ? " and others" : ""}
        </span>
      )}
    </span>
  );
}

function NotCopiedSection({ summary }: { summary: FolderUploadSummary }) {
  const { notCopied, rootName } = summary;
  if (notCopied.count === 0) return null;
  const shown = notCopied.items.slice(0, LIST_ROWS);
  const more = notCopied.count - shown.length;
  const reasons = new Set(notCopied.items.map((item) => item.reason));
  return (
    <section aria-label="Not copied">
      <PreviewSectionHeading label="Not copied" count={notCopied.count} />
      {reasons.size > 0 && (
        <p className="px-3 pb-1.5 text-text-secondary">{notCopiedReasons(reasons)}</p>
      )}
      {shown.length > 0 && (
        <ItemRows
          label="Not copied"
          rows={shown.map((item) => ({
            path: insideFolder(item.path, rootName),
            kind: null,
            detail: NOT_COPIED_LABEL[item.reason],
            share: null,
          }))}
        />
      )}
      {more > 0 && (
        <p className="px-3 pb-2.5 text-text-secondary">{`and ${pluralize(more, "other")}`}</p>
      )}
    </section>
  );
}

function RefusedPaths({
  problem,
  summary,
  refusal,
}: {
  problem: RefusalProblem;
  summary: FolderUploadSummary;
  refusal: FolderRefusal;
}) {
  // A host that had only counts names no contributors: the folder's own
  // largest items still show where the bulk is.
  if (refusal.paths.length === 0) {
    if (summary.largest.length === 0) return null;
    return (
      <section aria-label="Largest items">
        <PreviewSectionHeading label="Largest items" />
        <ItemRows label="Largest items" rows={largestRows(summary)} />
      </section>
    );
  }
  const byPath = new Map(summary.largest.map((item) => [item.path, item]));
  return (
    <section aria-label={refusal.pathsLabel}>
      <PreviewSectionHeading label={refusal.pathsLabel} />
      <ItemRows
        label={refusal.pathsLabel}
        rows={refusal.paths.map((path) => ({
          path: insideFolder(path, summary.rootName),
          kind: path.endsWith("/") ? "folder" : "file",
          detail: contributionText(byPath.get(path), problem, summary.lowerBound),
          share: null,
        }))}
      />
    </section>
  );
}

/**
 * The question a folder asks before any of it goes to the host: what it holds,
 * where it lands, and what stays behind. A folder over the limits, or with
 * names the host can't keep apart, gets the refusal form instead, which says
 * why and offers only Close.
 */
export function FolderUploadQuestion({
  question,
  onAnswer,
}: {
  question: FolderQuestion;
  onAnswer: (yes: boolean) => void;
}) {
  const { check, hostLabel } = question;
  const { summary } = check;
  const refused = check.status === "refused";
  const refusal =
    check.status === "refused"
      ? { problem: check.problem, ...folderRefusal(check.problem, summary) }
      : null;
  const decline = () => onAnswer(false);
  return (
    <AppDialog
      isOpen
      onClose={decline}
      size="md"
      hasPreview
      initialFocus="cancel"
      data-testid="folder-upload-question"
    >
      <AppDialog.Header>
        <AppDialog.Title>
          <TitleEntity
            action={refused ? "Can't send" : "Send"}
            name={summary.rootName}
            punctuation={refused ? "" : "?"}
          />
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <PreviewFrame>
          {refusal && (
            <PreviewNotice tone="error" title={refusal.title} testId="folder-upload-refusal">
              {refusal.detail}
            </PreviewNotice>
          )}
          <PreviewSummary testId="folder-upload-summary">
            <SummaryRow label="Folder">
              {/* One name with no folders to break between: plain text wraps
                  anywhere and keeps the label level with its first line. */}
              <span className="font-mono text-text-primary [overflow-wrap:anywhere]">
                {summary.rootName}
              </span>
            </SummaryRow>
            <SummaryRow label="Host">
              <span className="break-words text-text-primary">{hostLabel}</span>
            </SummaryRow>
            {!refused && (
              <SummaryRow label="Lands in">
                <span className="block text-text-primary">
                  A temporary inbox folder, outside the project
                </span>
                <span className="block text-text-secondary">
                  {`Removed after ${INBOX_TTL} without changes, or sooner if the inbox fills up`}
                </span>
              </SummaryRow>
            )}
            <SummaryRow
              label="Contents"
              aside={summary.lowerBound ? "counting stopped early" : undefined}
            >
              <span className="text-text-primary tabular-nums">
                {contentsText(summary.totals, summary.lowerBound)}
              </span>
            </SummaryRow>
            {!refused && (
              <SummaryRow label="Hidden">
                <HiddenValue summary={summary} />
              </SummaryRow>
            )}
          </PreviewSummary>
          {refusal ? (
            <RefusedPaths problem={refusal.problem} summary={summary} refusal={refusal} />
          ) : (
            <>
              {summary.largest.length > 0 && (
                <section aria-label="Largest items">
                  <PreviewSectionHeading label="Largest items" />
                  <ItemRows label="Largest items" rows={largestRows(summary)} />
                </section>
              )}
              <NotCopiedSection summary={summary} />
            </>
          )}
        </PreviewFrame>
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{ label: refused ? "Close" : "Cancel", onClick: decline }}
        primaryAction={
          refused ? undefined : { label: "Send folder", onClick: () => onAnswer(true) }
        }
      />
    </AppDialog>
  );
}
