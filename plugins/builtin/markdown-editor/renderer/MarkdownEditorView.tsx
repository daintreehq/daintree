import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import type { LanguageSupport } from "@codemirror/language";
import { AlertTriangle, ExternalLink, FileWarning, RefreshCw, XCircle } from "lucide-react";
import type { FileEditorViewProps } from "@/registry/fileEditorRegistry";
import { loadMarkdownSupport } from "@/components/FileViewer/codeMirrorLanguages";
import { useActiveAppScheme } from "@/hooks/useActiveAppScheme";
import { activateMarkdownLink } from "@/components/Markdown/markdownRenderPolicy";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { MarkdownEditorStatusBar } from "./MarkdownEditorStatusBar.js";
import { DocumentController } from "./documentController.js";
import { identityKey } from "../shared/protocol.js";
import { currentText, useDocumentStateStore, type DocumentRecord } from "./documentStateStore.js";
import {
  buildMarkdownEditorExtensions,
  themeCompartment,
  wrapCompartment,
} from "./markdownEditorExtensions.js";
import { getDaintreeEditorTheme } from "@/components/FileViewer/editorTheme";
import { unifiedDiff } from "./unifiedDiff.js";

// The diff surface is the app's own; it stays out of this chunk until a
// conflict actually asks for it.
const LazyDiffViewer = lazy(() =>
  import("@/components/Worktree/DiffViewer").then((m) => ({ default: m.DiffViewer }))
);

const REFUSAL_COPY: Record<NonNullable<DocumentRecord["refusal"]>, string> = {
  NOT_MARKDOWN: "Only Markdown files can be edited here",
  NOT_UTF8: "This file isn't valid UTF-8, so editing it here could corrupt it",
  TOO_LARGE: "This file is over 2 MiB, the editor's limit",
  SYMLINK: "This file is a symlink; edit the file it points to instead",
  NOT_A_FILE: "This path isn't a file",
};

function EditorSkeleton() {
  return (
    <div className="p-4 space-y-3">
      <Skeleton label="Loading editor">
        <SkeletonBone className="h-5 w-1/3" />
        <SkeletonText lines={12} />
      </Skeleton>
    </div>
  );
}

/**
 * The file panel's Edit mode for Markdown (#12323): a CodeMirror buffer over
 * the document the controller owns. The view is transient — it mounts and
 * unmounts with the mode — so every piece of document state lives in the
 * controller and the store, and this component only renders them.
 */
export function MarkdownEditorView(props: FileEditorViewProps) {
  const { panelId, filePath, fileName, rootPath, worktreePath, projectId, wrapLines } = props;
  const key = identityKey({ projectId, worktreePath, filePath });
  // The controller is acquired in an effect, never during render: acquiring
  // starts the document read and its subscriptions, which a discarded render
  // must not do. It outlives this view — see DocumentController.
  const [controller, setController] = useState<DocumentController | null>(null);
  useEffect(() => {
    setController(
      DocumentController.acquire({ panelId, filePath, fileName, rootPath, worktreePath, projectId })
    );
  }, [panelId, filePath, fileName, rootPath, worktreePath, projectId]);
  const record = useDocumentStateStore((state) => state.records[key]);
  const polarity = useActiveAppScheme().type;

  useEffect(() => {
    controller?.sync({ changeTick: props.changeTick });
  }, [controller, props.changeTick]);

  const [language, setLanguage] = useState<LanguageSupport | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadMarkdownSupport()
      .then((support) => {
        if (!cancelled) setLanguage(support);
      })
      .catch(() => {
        // Plain-text editing still works without the grammar.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The text this view last handed the controller, so a store update that
  // echoes our own typing is not re-applied to the buffer.
  const lastLocalTextRef = useRef<string | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [confirmLoadDisk, setConfirmLoadDisk] = useState(false);
  const [saveAsPath, setSaveAsPath] = useState<string | null>(null);
  const [saveAsError, setSaveAsError] = useState<string | null>(null);

  const ready =
    controller !== null && record?.status === "ready" && record.base !== null && language !== null;
  const loadGeneration = record?.loadGeneration ?? 0;

  // Inputs the editor reads at creation but must not be recreated for: wrap
  // and theme are reconfigured in place below, and the link policy's root is
  // fixed for the document's life. Synced in an effect so the creation effect
  // can read them without listing them as reasons to rebuild.
  const liveInputsRef = useRef({ polarity, wrapLines, filePath, rootPath, fileName });
  useEffect(() => {
    liveInputsRef.current = { polarity, wrapLines, filePath, rootPath, fileName };
  }, [polarity, wrapLines, filePath, rootPath, fileName]);

  // One EditorView per (document load); a fresh EditorState — and a fresh
  // undo history — on first load, on a clean reload after an external
  // change, and on taking the disk version over a conflict.
  useEffect(() => {
    const host = hostRef.current;
    if (!ready || !host || !language || !controller) return;
    const inputs = liveInputsRef.current;
    const text = currentText(controller.record()) ?? "";
    lastLocalTextRef.current = text;
    const restore = controller.takeViewState();
    const clampedAnchor = restore ? Math.min(restore.anchor, text.length) : 0;
    const clampedHead = restore ? Math.min(restore.head, text.length) : 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection: EditorSelection.single(clampedAnchor, clampedHead),
        extensions: buildMarkdownEditorExtensions({
          language,
          polarity: inputs.polarity,
          wrapLines: inputs.wrapLines,
          ariaLabel: inputs.fileName,
          callbacks: {
            onChange: (next) => {
              lastLocalTextRef.current = next;
              controller.setText(next);
            },
            onSave: () => void controller.save(),
            onFollowLink: (href) => {
              const { filePath: file, rootPath: root } = liveInputsRef.current;
              activateMarkdownLink(href, { filePath: file, rootPath: root });
            },
          },
        }),
      }),
      parent: host,
    });
    viewRef.current = view;
    if (restore) view.scrollDOM.scrollTop = restore.scrollTop;
    return () => {
      controller.rememberViewState({
        anchor: view.state.selection.main.anchor,
        head: view.state.selection.main.head,
        scrollTop: view.scrollDOM.scrollTop,
      });
      view.destroy();
      viewRef.current = null;
    };
  }, [ready, language, loadGeneration, controller]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.reconfigure(wrapLines ? EditorView.lineWrapping : []),
    });
  }, [wrapLines]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(getDaintreeEditorTheme(polarity)),
    });
  }, [polarity]);

  // A sibling panel on the same document typed: catch the buffer up. The
  // record is read from the store at that moment rather than captured, so the
  // effect keys on the version alone.
  const textVersion = record?.textVersion ?? 0;
  useEffect(() => {
    const view = viewRef.current;
    const latest = useDocumentStateStore.getState().records[key];
    if (!view || !latest) return;
    const text = currentText(latest);
    if (text === null || text === lastLocalTextRef.current) return;
    const doc = view.state.doc;
    if (doc.toString() === text) return;
    lastLocalTextRef.current = text;
    view.dispatch({ changes: { from: 0, to: doc.length, insert: text } });
  }, [textVersion, key]);

  // Cmd+F from the panel chrome lands in this editor's find bar while the
  // panel is focused, as it does for Source mode.
  useEffect(() => {
    if (!props.isFocused) return;
    const handler = () => {
      if (viewRef.current) openSearchPanel(viewRef.current);
    };
    window.addEventListener("daintree:find-in-panel", handler);
    return () => window.removeEventListener("daintree:find-in-panel", handler);
  }, [props.isFocused]);

  const handleSave = useCallback(async () => {
    if (!controller) return;
    // A save that lands makes the document clean, which disables the button
    // that was just pressed — and a disabled control drops its focus, so a
    // keyboard user ends up on nothing with the buffer they were editing one
    // blind Tab away. Hand focus back, but only when they are still where the
    // press left them: if the save was started from the buffer (Cmd+S) or they
    // have since moved somewhere else deliberately, taking focus would be the
    // ruder of the two mistakes.
    const from = document.activeElement;
    const fromSaveButton =
      from instanceof HTMLElement && from.dataset.testid === "markdown-editor-save";
    const clean = await controller.save();
    if (!clean || !fromSaveButton) return;
    const now = document.activeElement;
    if (now === from || now === null || now === document.body) viewRef.current?.focus();
  }, [controller]);
  const handleLoadDisk = useCallback(async () => {
    setConfirmLoadDisk(false);
    setShowCompare(false);
    await controller?.loadDiskVersion();
    viewRef.current?.focus();
  }, [controller]);
  const handleSaveAs = useCallback(async () => {
    if (!saveAsPath || !controller) return;
    const result = await controller.saveAs(saveAsPath);
    if (result.status === "saved") {
      setSaveAsPath(null);
      setSaveAsError(null);
      return;
    }
    setSaveAsError(
      result.status === "exists"
        ? "A file already exists at that path"
        : result.status === "refused"
          ? "Pick a Markdown path under 2 MiB"
          : result.message
    );
  }, [controller, saveAsPath]);

  const compareDiff = useMemo(() => {
    if (!showCompare || !record?.conflict || record.conflict.text === null) return null;
    return unifiedDiff(record.conflict.text, currentText(record) ?? "", {
      path: props.fileName,
    });
  }, [showCompare, record, props.fileName]);

  if (
    !controller ||
    !record ||
    record.status === "loading" ||
    (record.status === "ready" && language === null)
  ) {
    return <EditorSkeleton />;
  }

  if (record.status === "refused") {
    return (
      <div className="flex h-full flex-col items-center gap-3 p-6 [&>*:first-child]:mt-auto [&>*:last-child]:mb-auto">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileWarning className="h-6 w-6" />}
          title="Can't edit this file here"
          description={REFUSAL_COPY[record.refusal ?? "NOT_A_FILE"]}
          action={
            <Button variant="outline" size="sm" onClick={props.onOpenExternalEditor}>
              <ExternalLink />
              Open in editor
            </Button>
          }
        />
      </div>
    );
  }

  if (record.status === "unavailable" && !record.base) {
    const orphanDraft = record.draft?.text ?? null;
    return (
      <div className="flex h-full flex-col items-center gap-3 p-6 [&>*:first-child]:mt-auto [&>*:last-child]:mb-auto">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileWarning className="h-6 w-6" />}
          title="File isn't available"
          description={
            orphanDraft === null
              ? "It may have been deleted, moved, or its worktree removed."
              : "It may have been deleted, moved, or its worktree removed. An unsaved draft of it is kept here until you save or discard it."
          }
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void controller.load({ restoreDraft: true })}
              >
                <RefreshCw />
                Retry
              </Button>
              {orphanDraft !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(orphanDraft)}
                  data-testid="markdown-editor-copy-draft"
                >
                  Copy draft
                </Button>
              )}
            </div>
          }
        />
      </div>
    );
  }

  const base = record.base;
  const text = currentText(record) ?? "";
  const dirty = record.draft !== null;
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;
  const eolLabel = base?.eol === "\r\n" ? "CRLF" : "LF";

  return (
    <div className="flex min-h-full flex-col" data-testid="markdown-editor">
      <MarkdownEditorStatusBar
        lineCount={lineCount}
        byteLength={new TextEncoder().encode(text).byteLength}
        hasBom={base?.hasBom ?? false}
        eolLabel={eolLabel}
        mixedEol={base?.mixedEol ?? false}
        dirty={dirty}
        saving={record.saving}
        saveBlocked={record.conflict !== null}
        onSave={() => void handleSave()}
      />

      {record.status === "unavailable" && (
        <InlineStatusBanner
          severity="warning"
          icon={AlertTriangle}
          title="File isn't where it was"
          description="The draft is kept. Save it somewhere else, or retry once the file is back."
          role="status"
          ariaLive="polite"
          actions={[
            {
              id: "retry-unavailable",
              label: "Retry",
              icon: RefreshCw,
              onClick: () => void controller.revalidate(),
            },
            {
              id: "save-as-unavailable",
              label: "Save draft as…",
              onClick: () => setSaveAsPath(props.filePath.replace(/(\.[^./\\]+)?$/, "-draft$1")),
            },
          ]}
        />
      )}

      {record.conflict && (
        <InlineStatusBanner
          severity="warning"
          icon={AlertTriangle}
          title="File changed on disk"
          description="Your draft is kept and saving is held. Compare the two, load the disk version, or save the draft elsewhere."
          role="status"
          ariaLive="polite"
          actions={[
            {
              id: "compare",
              label: showCompare ? "Hide comparison" : "Compare",
              onClick: () => setShowCompare((value) => !value),
              disabled: record.conflict.text === null,
            },
            {
              id: "load-disk",
              label: "Load disk version",
              onClick: () => setConfirmLoadDisk(true),
            },
            {
              id: "save-as",
              label: "Save draft as…",
              onClick: () => setSaveAsPath(props.filePath.replace(/(\.[^./\\]+)?$/, "-draft$1")),
            },
          ]}
        />
      )}

      {record.error && (
        <InlineStatusBanner
          severity="error"
          icon={XCircle}
          title="Couldn't save"
          description={record.error}
          action={{
            id: "retry-save",
            label: "Retry",
            icon: RefreshCw,
            onClick: () => void handleSave(),
          }}
        />
      )}

      {record.storageWarning && (
        <InlineStatusBanner
          severity="warning"
          icon={AlertTriangle}
          title="Draft isn't backed up"
          description={record.storageWarning}
          role="status"
          ariaLive="polite"
          actions={[
            {
              id: "copy-draft",
              label: "Copy draft",
              onClick: () => void navigator.clipboard.writeText(text),
            },
          ]}
        />
      )}

      {compareDiff !== null && (
        <div
          className="border-b border-border-default diff-scroll-root"
          data-testid="markdown-editor-compare"
        >
          <Suspense fallback={<EditorSkeleton />}>
            <LazyDiffViewer diff={compareDiff} viewType="unified" wrapLines />
          </Suspense>
        </div>
      )}

      <div
        ref={hostRef}
        className={cn(
          "flex-1 text-sm leading-[inherit] [&_.cm-editor]:min-h-full [&_.cm-scroller]:!overflow-visible",
          !ready && "hidden"
        )}
        data-testid="markdown-editor-host"
      />

      <ConfirmDialog
        isOpen={confirmLoadDisk}
        onClose={() => setConfirmLoadDisk(false)}
        variant="destructive"
        zIndex="nested"
        title={`Discard the draft of '${props.fileName}'?`}
        description="The disk version replaces your unsaved edits. This can't be undone."
        confirmLabel="Discard draft"
        onConfirm={handleLoadDisk}
      />

      <ConfirmDialog
        isOpen={saveAsPath !== null}
        onClose={() => {
          setSaveAsPath(null);
          setSaveAsError(null);
        }}
        variant="default"
        title="Save draft as"
        description="A new Markdown file inside the same root. The original file and its draft are left as they are."
        confirmLabel="Save file"
        onConfirm={handleSaveAs}
        hint={saveAsError ?? undefined}
      >
        <input
          value={saveAsPath ?? ""}
          onChange={(event) => setSaveAsPath(event.target.value)}
          aria-label="New file path"
          className="w-full rounded-md border border-border-default bg-surface-canvas px-2 py-1.5 font-mono text-xs text-text-primary focus:outline-hidden focus-visible:ring-1 focus-visible:ring-border-strong"
          data-testid="markdown-editor-save-as-path"
        />
      </ConfirmDialog>
    </div>
  );
}
