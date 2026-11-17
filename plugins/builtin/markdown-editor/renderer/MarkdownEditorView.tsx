import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import type { LanguageSupport } from "@codemirror/language";
import type { FileEditorViewProps } from "@/registry/fileEditorRegistry";
import { loadMarkdownSupport } from "@/components/FileViewer/codeMirrorLanguages";
import {
  countLines,
  detectLineEnding,
  type FileLineEnding,
} from "@/components/FileViewer/FileMetadataFacts";
import { utf8ByteLength } from "@shared/utils/folderUpload";
import { activateMarkdownLink } from "@/components/Markdown/markdownLinkPolicy";
// The host banner for the conflict strip only: its Compare action has to stay
// focusable while unavailable, and a kit Button can only be natively disabled.
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import {
  Button,
  Callout,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Icon,
  Input,
  Skeleton,
  SkeletonBone,
  SkeletonText,
  useDaintreeTheme,
} from "@daintreehq/plugin-ui";
import { cn } from "@/lib/utils";
import { isEnterToSubmit } from "@/lib/enterToSubmit";
import { canPanelTakeFind } from "@/lib/findInPanel";
import { MarkdownEditorStatusBar } from "./MarkdownEditorStatusBar.js";
import { DocumentController } from "./documentController.js";
import { identityKey } from "../shared/ids.js";
import {
  currentText,
  useDocumentStateStore,
  type DocumentBase,
  type DocumentRecord,
} from "./documentStateStore.js";
import {
  buildMarkdownEditorExtensions,
  docUtf8Bytes,
  externalChange,
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

/** The live buffer's size, measured by CodeMirror as it changes rather than from a string. */
interface BufferMetrics {
  lines: number;
  bytes: number;
}

function measure(state: EditorState): BufferMetrics {
  // An empty buffer has no lines, as the reader's strip counts it.
  return { lines: state.doc.length === 0 ? 0 : state.doc.lines, bytes: state.field(docUtf8Bytes) };
}

/**
 * One view's buffer metrics, read by its status line alone: typing re-renders
 * the strip, never the editor shell around it (#17071).
 */
function createMetricsSource() {
  let value: BufferMetrics | null = null;
  const listeners = new Set<() => void>();
  return {
    get: (): BufferMetrics | null => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next: BufferMetrics | null) => {
      if (next?.lines === value?.lines && next?.bytes === value?.bytes) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}
type MetricsSource = ReturnType<typeof createMetricsSource>;

function LiveStatusBar({
  metrics,
  base,
  dirty,
  draftText,
  ...rest
}: {
  metrics: MetricsSource;
  base: DocumentBase | null;
  dirty: boolean;
  /** The committed draft, for a document with no buffer mounted to measure. */
  draftText: string | null;
  filePath: string;
  saving: boolean;
  saveBlocked: boolean;
  onSave: () => void;
}) {
  const live = useSyncExternalStore(metrics.subscribe, metrics.get);
  const baseFacts = useMemo(
    () => (base ? { lines: countLines(base.text), ending: detectLineEnding(base.text) } : null),
    [base]
  );
  const crlf = base?.eol === "\r\n";
  const bom = base?.hasBom ? 3 : 0;
  let lineCount: number;
  let bufferEnding: FileLineEnding | null;
  let byteLength: number;
  if (!dirty && base && baseFacts) {
    // A clean document is the file, so it reports the size Source mode reads off disk.
    lineCount = baseFacts.lines;
    bufferEnding = baseFacts.ending;
    byteLength = base.size;
  } else if (live) {
    // A draft has no disk size yet; it reports what a save would write — its
    // own ending and BOM re-applied to the `\n`-joined, BOM-less buffer,
    // which holds no other break.
    lineCount = live.lines;
    bufferEnding = live.lines > 1 ? "LF" : null;
    byteLength = live.bytes + (crlf ? Math.max(0, live.lines - 1) : 0) + bom;
  } else {
    const text = draftText ?? "";
    lineCount = countLines(text);
    bufferEnding = detectLineEnding(text);
    byteLength = utf8ByteLength(text) + (crlf ? Math.max(0, lineCount - 1) : 0) + bom;
  }
  // What the file has, not what a save would write. The buffer stores the
  // dominant ending as `\n` and keeps any lone CR, so a `\n` here is the
  // file's own ending and a CR is a CR.
  const lineEnding = base?.mixedEol
    ? "mixed"
    : bufferEnding === "LF" && crlf
      ? "CRLF"
      : bufferEnding;
  return (
    <MarkdownEditorStatusBar
      {...rest}
      lineCount={lineCount}
      byteLength={byteLength}
      hasBom={base?.hasBom ?? false}
      eolLabel={crlf ? "CRLF" : "LF"}
      lineEnding={lineEnding}
      dirty={dirty}
    />
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
  const [showCompare, setShowCompare] = useState(false);
  const [metrics] = useState(createMetricsSource);
  // Flips when a buffer starts or stops being measured, not as it changes.
  const measuring = useSyncExternalStore(metrics.subscribe, () => metrics.get() !== null);
  // The shell's own state, not the draft text: typing leaves every field here
  // as it was, so it re-renders nothing (#17071). Text is taken only while a
  // surface shows or copies it, or no buffer is there to measure.
  const record = useDocumentStateStore(
    useShallow((state) => {
      const current = state.records[key];
      if (!current) return undefined;
      const showsText =
        !measuring || showCompare || current.storageWarning !== null || current.status !== "ready";
      return {
        status: current.status,
        refusal: current.refusal,
        base: current.base,
        dirty: current.draft !== null,
        conflict: current.conflict,
        saving: current.saving,
        error: current.error,
        storageWarning: current.storageWarning,
        loadGeneration: current.loadGeneration,
        text: showsText ? currentText(current) : null,
      };
    })
  );
  const polarity = useDaintreeTheme().colorMode;

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
  const headerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
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
    const restore = controller.takeViewState();
    const clampedAnchor = restore ? Math.min(restore.anchor, text.length) : 0;
    const clampedHead = restore ? Math.min(restore.head, text.length) : 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection: EditorSelection.single(clampedAnchor, clampedHead),
        extensions: [
          buildMarkdownEditorExtensions({
            language,
            polarity: inputs.polarity,
            wrapLines: inputs.wrapLines,
            ariaLabel: inputs.fileName,
            pinnedTopInset: () => headerRef.current?.offsetHeight ?? 0,
            callbacks: {
              onChange: (doc) => controller.edit(doc),
              onSave: () => void controller.save(),
              onFollowLink: (href) => {
                const { filePath: file, rootPath: root } = liveInputsRef.current;
                activateMarkdownLink(href, { filePath: file, rootPath: root });
              },
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) metrics.set(measure(update.state));
          }),
          // Typing a sibling panel ran ahead of the shared draft: commit it on
          // the way in, so this buffer is caught up before a key lands in it.
          // Leaving commits too, so whatever the user goes to sees it all.
          EditorView.domEventHandlers({
            focus: () => {
              controller.flushPending();
              return false;
            },
            blur: () => {
              controller.flushPending();
              return false;
            },
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    metrics.set(measure(view.state));
    if (restore) view.scrollDOM.scrollTop = restore.scrollTop;
    // A sibling panel on the same document committed typing: catch the
    // buffer up. Our own commits come back through here too, and are skipped
    // by who made them rather than by comparing the document.
    let synced = text;
    const unsubscribe = useDocumentStateStore.subscribe((state) => {
      const latest = state.records[key];
      // A replaced document gets a fresh editor, not a patched one.
      if (!latest || latest.loadGeneration !== loadGeneration) return;
      const next = currentText(latest);
      if (next === null || next === synced) return;
      synced = next;
      if (controller.committedHere(next)) return;
      const doc = view.state.doc;
      if (doc.toString() === next) return;
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: next },
        annotations: externalChange.of(true),
      });
    });
    return () => {
      unsubscribe();
      controller.rememberViewState({
        anchor: view.state.selection.main.anchor,
        head: view.state.selection.main.head,
        scrollTop: view.scrollDOM.scrollTop,
      });
      view.destroy();
      viewRef.current = null;
      metrics.set(null);
    };
  }, [ready, language, loadGeneration, controller, key, metrics]);

  // Leaving Edit commits what was typed before the next mode paints from it.
  useLayoutEffect(() => () => controller?.flushPending(), [controller]);

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

  // Cmd+F from the panel chrome lands in this editor's find bar while the
  // panel is focused, as it does for Source mode. A modal over the panel keeps
  // it out.
  useEffect(() => {
    if (!props.isFocused) return;
    const handler = () => {
      if (!canPanelTakeFind(hostRef.current)) return;
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
    const outcome = await controller.save();
    if (outcome.status !== "saved" || !fromSaveButton) return;
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
    return unifiedDiff(record.conflict.text, record.text ?? "", { path: props.fileName });
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
          icon={<Icon name="file-warning" className="h-6 w-6" />}
          title="Can't edit this file here"
          description={REFUSAL_COPY[record.refusal ?? "NOT_A_FILE"]}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={props.onOpenExternalEditor}
              icon="external-link"
            >
              Open in editor
            </Button>
          }
        />
      </div>
    );
  }

  if (record.status === "unavailable" && !record.base) {
    const orphanDraft = record.dirty ? record.text : null;
    return (
      <div className="flex h-full flex-col items-center gap-3 p-6 [&>*:first-child]:mt-auto [&>*:last-child]:mb-auto">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<Icon name="file-warning" className="h-6 w-6" />}
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
                icon="refresh"
              >
                Retry
              </Button>
              {orphanDraft !== null && (
                <CopyButton
                  label="Copy draft"
                  text={orphanDraft}
                  variant="outline"
                  size="sm"
                  data-testid="markdown-editor-copy-draft"
                />
              )}
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col" data-testid="markdown-editor">
      {/* Pinned by sticking to the pane body, which is the scroller in a grid
          cell and in a content-sized dialog alike. A scroller of the view's own
          would need `h-full`, which collapses to the content's height inside a
          dialog and leaves that scroller never scrolling. Opaque, because the
          document passes beneath it. */}
      <div
        ref={headerRef}
        className="sticky top-0 z-10 shrink-0 bg-surface-canvas"
        data-testid="markdown-editor-header"
      >
        <LiveStatusBar
          metrics={metrics}
          base={record.base}
          dirty={record.dirty}
          draftText={record.dirty ? record.text : null}
          filePath={filePath}
          saving={record.saving}
          saveBlocked={record.conflict !== null}
          onSave={() => void handleSave()}
        />
      </div>

      {/* `isolate` keeps CodeMirror's gutters (z-index 200), its find bar (300)
          and the comparison's sticky file header inside this layer, so none
          paints over the strip as it scrolls beneath. */}
      <div className="isolate flex flex-1 flex-col">
        {record.status === "unavailable" && (
          <Callout
            variant="strip"
            severity="warning"
            title="File isn't where it was"
            role="status"
            aria-live="polite"
            actionPlacement="below"
            action={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  icon="refresh"
                  // The banner's own mark for its recommended action, which the
                  // forced-colours rules draw with the heavier border.
                  data-notification-action="primary"
                  onClick={() => void controller.revalidate()}
                >
                  Retry
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-notification-action="primary"
                  onClick={() =>
                    setSaveAsPath(props.filePath.replace(/(\.[^./\\]+)?$/, "-draft$1"))
                  }
                >
                  Save draft as…
                </Button>
              </>
            }
          >
            The draft is kept. Save it somewhere else, or retry once the file is back.
          </Callout>
        )}

        {record.conflict && (
          <InlineStatusBanner
            severity="warning"
            title={record.conflict.tooLarge ? "File on disk is over 2 MiB" : "File changed on disk"}
            description={
              record.conflict.tooLarge
                ? "It grew past the editor's limit, so it can't be compared or loaded here. Your draft is kept and saving is held; save the draft elsewhere."
                : "Your draft is kept and saving is held. Compare the two, load the disk version, or save the draft elsewhere."
            }
            role="status"
            ariaLive="polite"
            actions={[
              {
                id: "compare",
                label: showCompare ? "Hide comparison" : "Compare",
                onClick: () => {
                  controller.flushPending();
                  setShowCompare((value) => !value);
                },
                disabled: record.conflict.text === null,
              },
              {
                id: "load-disk",
                label: "Load disk version",
                onClick: () => setConfirmLoadDisk(true),
                disabled: record.conflict.tooLarge,
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
          <Callout
            variant="strip"
            severity="error"
            title="Couldn't save"
            actionPlacement="below"
            action={
              <Button
                variant="outline"
                size="sm"
                icon="refresh"
                data-notification-action="primary"
                onClick={() => void handleSave()}
              >
                Retry
              </Button>
            }
          >
            {record.error}
          </Callout>
        )}

        {record.storageWarning && (
          <Callout
            variant="strip"
            severity="warning"
            title="Draft isn't backed up"
            role="status"
            aria-live="polite"
            actionPlacement="below"
            action={
              // The copy announces itself; keep its label swap out of the warning's live region.
              <span aria-live="off" className="inline-flex">
                <CopyButton
                  label="Copy draft"
                  text={record.text ?? ""}
                  variant="outline"
                  size="sm"
                  data-notification-action="primary"
                  data-testid="markdown-editor-copy-draft"
                />
              </span>
            }
          >
            {record.storageWarning}
          </Callout>
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
            // The find bar stays inside the editor, where its horizontal-scroll
            // follow and the find-mode highlight rules reach it, and sticks
            // just under the strip: `top-7` is the strip's fixed `h-7`
            // (FILE_METADATA_STRIP_CLASS).
            "flex-1 text-sm leading-[inherit] [&_.cm-editor]:min-h-full [&_.cm-scroller]:!overflow-visible [&_.cm-panels-top]:!top-7",
            !ready && "hidden"
          )}
          data-testid="markdown-editor-host"
        />
      </div>

      <ConfirmDialog
        open={confirmLoadDisk}
        onClose={() => setConfirmLoadDisk(false)}
        variant="destructive"
        layer="nested"
        title={`Discard changes to '${props.fileName}'?`}
        description="The version on disk replaces your unsaved edits, and the draft isn't kept."
        confirmLabel="Discard changes"
        onConfirm={handleLoadDisk}
      />

      <ConfirmDialog
        open={saveAsPath !== null}
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
        <Input
          density="compact"
          value={saveAsPath ?? ""}
          onValueChange={setSaveAsPath}
          onKeyDown={(event) => {
            if (!isEnterToSubmit(event)) return;
            event.preventDefault();
            void handleSaveAs();
          }}
          aria-label="New file path"
          invalid={saveAsError !== null}
          className="font-mono"
          data-testid="markdown-editor-save-as-path"
        />
      </ConfirmDialog>
    </div>
  );
}
