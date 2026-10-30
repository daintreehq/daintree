import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { DiffStat } from "@/components/ui/DiffStat";
import { PathSegments } from "@/components/ui/PathSegments";
import { TitleEntity } from "@/components/ui/TitleEntity";
import {
  PreviewFrame,
  PreviewNote,
  PreviewNotice,
  PreviewSectionHeading,
  PreviewSkeleton,
  PreviewSummary,
  SummaryRow,
} from "@/components/Git/GitOperationPreview";
import {
  FilePatchPreview,
  newFileText,
  type PreviewSection,
} from "@/components/Git/FilePatchPreview";
import {
  discardCopy,
  pendingCopy,
  plainMessage,
  trashCopy,
  trashName,
} from "@/components/Git/fileMutationCopy";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatBytes } from "@/lib/formatBytes";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isClientAppError } from "@/utils/clientAppError";
import { useFileMutationConfirmStore } from "@/store/fileMutationConfirmStore";
import type {
  FileChangeSide,
  FileChurn,
  FileDiscardPreview,
  FileMutationPreview,
  FileTextSample,
  FileTrashPreview,
} from "@shared/types/fileMutation";

type PreviewState =
  | { status: "loading"; seq: number }
  | { status: "ready"; seq: number; preview: FileMutationPreview }
  | { status: "failed"; seq: number; code: string | undefined; message: string };

function baseName(relativePath: string): string {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? relativePath;
}

// Every value in the summary at one size: the kit's smaller `MissingValue` is
// sized to sit beside ref chips, and next to plain values it read as a
// second, lesser type size.
function NoValue() {
  return <span className="text-text-secondary">None</span>;
}

function Churn({ churn }: { churn: FileChurn | null }) {
  if (churn === null) return <NoValue />;
  if (churn === "binary") return <span className="text-text-primary">Binary file</span>;
  // A rename or a mode change with no lines of its own.
  if (churn.insertions === 0 && churn.deletions === 0) {
    return <span className="text-text-primary">No line changes</span>;
  }
  return <DiffStat insertions={churn.insertions} deletions={churn.deletions} />;
}

/** A path as a value: primary ink, mono, wrapping between folders. */
function PathValue({ path }: { path: string }) {
  return (
    <span className="font-mono text-text-primary">
      <span className="sr-only">{path}</span>
      <span aria-hidden="true">
        <PathSegments path={path} />
      </span>
    </span>
  );
}

function sideSection(label: string, side: FileChangeSide | null): PreviewSection | null {
  if (side === null || side.churn === "binary" || side.patch === "") return null;
  return { kind: "patch", label, patch: side.patch };
}

function sampleSize(sample: FileTextSample): string {
  return sample.lines !== null
    ? `${pluralize(sample.lines, "line")} · ${formatBytes(sample.bytes)}`
    : formatBytes(sample.bytes);
}

/** A file's own first lines, or why there are none to show. */
function SampleContents({ sample, label }: { sample: FileTextSample; label: string }) {
  if (sample.binary || !sample.excerpt) {
    return (
      <PreviewNote>
        {sample.binary ? "A binary file has no preview." : "The file is empty."}
      </PreviewNote>
    );
  }
  return (
    <FilePatchPreview
      sections={[{ kind: "text", label, text: sample.excerpt }]}
      label={label}
      footer={
        sample.excerptTruncated
          ? sample.lines !== null
            ? `Showing the first lines of ${pluralize(sample.lines, "line")}.`
            : "Showing the first lines of a large file."
          : undefined
      }
    />
  );
}

function DiscardBody({ preview, trash }: { preview: FileDiscardPreview; trash: string }) {
  const { staged, unstaged, outcome, overwrites } = preview;

  // A deletion coming back: nothing is lost, so the frame says what returns
  // rather than showing the deletion as a red count.
  if (outcome === "restore") {
    const restoredLines = [staged, unstaged].reduce(
      (most, side) =>
        side && side.churn !== "binary" ? Math.max(most, side.churn.deletions) : most,
      0
    );
    return (
      <PreviewSummary testId="file-mutation-summary">
        <SummaryRow label="Restores">
          <span className="text-text-primary">
            {restoredLines > 0
              ? `${pluralize(restoredLines, "line")}, from the last commit`
              : "The last committed version"}
          </span>
        </SummaryRow>
      </PreviewSummary>
    );
  }

  // A file that only comes into being in this change — new, or a copy — is
  // shown as its contents; a column of "+" signs adds nothing to it.
  const createdText =
    outcome === "trash" && preview.renamedFrom === null && staged && unstaged === null
      ? newFileText(staged.patch)
      : null;
  const sections: PreviewSection[] =
    createdText !== null
      ? [{ kind: "text", label: "Contents", text: createdText }]
      : [sideSection("Staged", staged), sideSection("Unstaged", unstaged)].filter(
          (section): section is PreviewSection => section !== null
        );
  const truncated = Boolean(staged?.truncated || unstaged?.truncated);
  const heading =
    outcome === "lose"
      ? "Changes to discard"
      : preview.renamedFrom !== null
        ? "Changes in the renamed copy"
        : `Moving to the ${trash}`;

  return (
    <>
      <PreviewSummary testId="file-mutation-summary">
        {preview.renamedFrom !== null && (
          <SummaryRow label="Old name">
            <PathValue path={preview.renamedFrom} />
          </SummaryRow>
        )}
        {preview.copiedFrom !== null && (
          <SummaryRow label="Copy of">
            <PathValue path={preview.copiedFrom} />
          </SummaryRow>
        )}
        <SummaryRow label="Staged">
          <Churn churn={staged?.churn ?? null} />
        </SummaryRow>
        <SummaryRow label="Unstaged">
          <Churn churn={unstaged?.churn ?? null} />
        </SummaryRow>
        {overwrites !== null && (
          <SummaryRow label="On disk">
            <span className="text-text-primary">{sampleSize(overwrites)}</span>
          </SummaryRow>
        )}
      </PreviewSummary>
      {overwrites !== null ? (
        // What the restore destroys, never the committed lines it brings back.
        <>
          <PreviewSectionHeading label="Written over" />
          <SampleContents sample={overwrites} label="The file the restore writes over" />
        </>
      ) : sections.length > 0 ? (
        <>
          <PreviewSectionHeading label={heading} />
          <FilePatchPreview
            sections={sections}
            label={heading}
            footer={
              truncated ? "The preview stops here. The diff has the rest of the change." : undefined
            }
          />
        </>
      ) : (
        <PreviewNote>
          {staged?.churn === "binary" || unstaged?.churn === "binary"
            ? "A binary file has no line preview."
            : truncated
              ? "This change is too large to preview here. The diff has all of it."
              : "No content changes, only the name."}
        </PreviewNote>
      )}
    </>
  );
}

function TrashBody({ preview }: { preview: FileTrashPreview }) {
  const inGit = preview.inLastCommit
    ? "Last committed version"
    : preview.inIndex
      ? "Staged version only"
      : preview.ignored
        ? "No copy, ignored"
        : "No copy";
  return (
    <>
      <PreviewSummary testId="file-mutation-summary">
        <SummaryRow label="Size">
          <span className="text-text-primary">{sampleSize(preview)}</span>
        </SummaryRow>
        <SummaryRow label="In git">
          <span className="text-text-primary">{inGit}</span>
        </SummaryRow>
        {preview.inIndex && (
          <SummaryRow label="Staged" aside={preview.staged ? "stays staged" : undefined}>
            <Churn churn={preview.staged} />
          </SummaryRow>
        )}
        {preview.inIndex && (
          <SummaryRow label="Unstaged" aside={preview.unstaged ? "moves with the file" : undefined}>
            <Churn churn={preview.unstaged} />
          </SummaryRow>
        )}
      </PreviewSummary>
      {(preview.excerpt || preview.binary) && !preview.inLastCommit && !preview.inIndex && (
        <>
          <PreviewSectionHeading label="Contents" />
          <SampleContents sample={preview} label="File contents" />
        </>
      )}
    </>
  );
}

/**
 * The confirm for `git.discardFileChanges` and `file.trash` (#13424, #15122).
 *
 * It says what the operation would do to this file as it stands — read from
 * the main process's own plan, not the row's status — and shows what is at
 * stake: the staged and unstaged changes and the lines themselves for a
 * discard; whether git keeps a copy, and the file's own first lines when it
 * doesn't, for a trash. The discard approval carries the preview's
 * fingerprint, so what goes is what was shown.
 *
 * It stays unmounted until the preview has landed, up to the Doherty gate:
 * most reads finish inside it, and the dialog then opens whole instead of
 * growing under the pointer. A slower read opens on a skeleton.
 */
function FileMutationConfirmDialogInner() {
  const pendingConfirm = useFileMutationConfirmStore((s) => s.pendingConfirm);
  const requestSeq = useFileMutationConfirmStore((s) => s.requestSeq);
  const resolveConfirmation = useFileMutationConfirmStore((s) => s.resolveConfirmation);

  const [state, setState] = useState<PreviewState>({ status: "loading", seq: -1 });
  const requestIdRef = useRef(0);

  const kind = pendingConfirm?.kind ?? null;
  const relativePath = pendingConfirm?.relativePath ?? null;
  const worktreePath = pendingConfirm?.worktreePath ?? null;

  const loadPreview = useCallback(() => {
    if (kind === null || relativePath === null || worktreePath === null) return;
    const requestId = ++requestIdRef.current;
    const seq = requestSeq;
    setState({ status: "loading", seq });
    safeFireAndForget(
      window.electron.git
        .previewFileMutation({ worktreePath, relativePath, kind })
        .then((preview) => {
          if (requestIdRef.current !== requestId) return;
          setState({ status: "ready", seq, preview });
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          // Decodes the AppError prefix in place; read the code after it.
          const code = isClientAppError(err) ? err.code : undefined;
          setState({
            status: "failed",
            seq,
            code,
            message: plainMessage(err, formatErrorMessage(err, "")),
          });
        }),
      { context: "FileMutationConfirmDialog: load preview" }
    );
  }, [kind, relativePath, worktreePath, requestSeq]);

  useEffect(() => {
    if (kind === null) {
      // Bumped, not just reset: a read still in flight when the dialog closes
      // would otherwise land and stand ready for whatever asks next.
      requestIdRef.current++;
      setState({ status: "loading", seq: -1 });
      return;
    }
    loadPreview();
  }, [kind, loadPreview]);

  // Resolve on unmount so the awaiting action never hangs.
  useEffect(() => {
    return () => {
      if (useFileMutationConfirmStore.getState().pendingConfirm) {
        useFileMutationConfirmStore.getState().resolveConfirmation(null);
      }
    };
  }, []);

  // Only this request's own answer counts: the host stays mounted across
  // requests, and the previous file's preview must never stand in for this one.
  const current = state.seq === requestSeq ? state : null;
  const isSettled = current !== null && current.status !== "loading";
  const showSlowRead = useDeferredLoading(kind !== null && !isSettled, UI_DOHERTY_THRESHOLD);

  if (!pendingConfirm || (!isSettled && !showSlowRead)) return null;

  const trash = trashName();
  const preview = current?.status === "ready" ? current.preview : null;
  const failure = current?.status === "failed" ? current : null;
  const copy = preview
    ? preview.kind === "discard"
      ? discardCopy(preview, trash)
      : trashCopy(preview, trash)
    : pendingCopy(pendingConfirm.kind);
  const isDiscard = pendingConfirm.kind === "discard";
  // Nothing left to act on: the file already matches its last commit, or is
  // already gone. Said in the frame, with the primary stood down.
  const isNothingToDo = failure?.code === "NOT_FOUND";

  const hint = isNothingToDo
    ? isDiscard
      ? "Nothing to discard"
      : "Nothing to trash"
    : failure
      ? "Retry the preview to continue"
      : !isSettled
        ? isDiscard
          ? "Reading this file's changes…"
          : "Reading this file…"
        : null;

  let frameBody: ReactNode;
  if (preview?.kind === "discard") {
    frameBody = <DiscardBody preview={preview} trash={trash} />;
  } else if (preview?.kind === "trash") {
    frameBody = <TrashBody preview={preview} />;
  } else if (isNothingToDo) {
    frameBody = (
      <PreviewNote testId="file-mutation-nothing-to-do">
        {isDiscard
          ? "The file already matches its last commit, so there's nothing to discard."
          : "The file is already gone."}
      </PreviewNote>
    );
  } else if (failure) {
    frameBody = (
      <PreviewNotice
        tone="error"
        title={isDiscard ? "Couldn't read this file's changes" : "Couldn't read this file"}
        onRetry={loadPreview}
        retryTestId="file-mutation-preview-retry"
        testId="file-mutation-preview-error"
      >
        {failure.message}
      </PreviewNotice>
    );
  } else {
    frameBody = (
      <PreviewSkeleton
        label={isDiscard ? "Reading this file's changes" : "Reading this file"}
        testId="file-mutation-preview-loading"
      />
    );
  }

  const hasLines =
    (preview?.kind === "discard" &&
      preview.outcome !== "restore" &&
      Boolean(preview.staged?.patch || preview.unstaged?.patch || preview.overwrites?.excerpt)) ||
    (preview?.kind === "trash" && Boolean(preview.excerpt));

  return (
    <ConfirmDialog
      isOpen={true}
      variant={copy.destructive ? "destructive" : "default"}
      // The menu that asks can sit inside a dialog of its own — the Review
      // Hub's diff is nested — and a confirm behind it can't be answered.
      zIndex="nested"
      size={hasLines || (isDiscard && !isSettled) ? "lg" : "sm"}
      hasPreview={true}
      // Cancel first for every variant: the neutral ones still take a file away.
      initialFocus="cancel"
      // The host is reused across requests; a new file must not inherit the
      // last one's focus or scroll position.
      focusResetKey={requestSeq}
      bodyResetKey={requestSeq}
      onClose={() => resolveConfirmation(null)}
      onConfirm={() =>
        resolveConfirmation({ token: preview?.kind === "discard" ? preview.token : null })
      }
      title={<TitleEntity action={copy.action} name={baseName(pendingConfirm.relativePath)} />}
      description={
        <>
          <span className="block" data-testid="file-mutation-path">
            <PathValue path={pendingConfirm.relativePath} />
          </span>
          {copy.description && (
            <span className="mt-1.5 block [text-wrap:pretty]">{copy.description}</span>
          )}
        </>
      }
      confirmLabel={copy.confirmLabel}
      confirmDisabled={preview === null}
      hint={hint}
    >
      <PreviewFrame>{frameBody}</PreviewFrame>
    </ConfirmDialog>
  );
}

export function FileMutationConfirmDialog() {
  const requestSeq = useFileMutationConfirmStore((s) => s.requestSeq);
  return (
    <ErrorBoundary
      variant="component"
      componentName="FileMutationConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <FileMutationConfirmDialogInner />
    </ErrorBoundary>
  );
}
