import type { ComponentProps, RefObject } from "react";
import {
  Copy,
  Download,
  ExternalLink,
  FileDiff as FileDiffIcon,
  Globe,
  RefreshCw,
  WrapText,
  XCircle,
} from "lucide-react";
import type { FileViewMode } from "@shared/types/panel";
import { FolderOpen, FolderTree } from "@/components/icons";
import {
  MarkdownTextSizeControl,
  MarkdownTextSizeMenuItems,
} from "@/components/Markdown/MarkdownTextSizeControl";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { getFileTypeIcon } from "@/panels/file-browser/fileTypeIcons";
import { saveHostFileLabel } from "@/services/hostFileSave";
import { FileViewerToolbar, TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import type { RevealCopy } from "@/components/FileViewer/revealCopy";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { FileEditorDefaultNotice } from "@/components/Plugin/FileEditorDefaultNotice";
import { FileEditorBanner } from "@/components/FileViewer/FileEditorBanner";
import { copyWithToast } from "@/lib/copyWithToast";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import type { ProjectSurfaceChoice } from "@shared/types/plugin";
import { FileEditorPicker } from "./FileEditorPicker";
import type { FileEditorChoice, FileEditorPickerModel } from "./useFileEditorChoice";
import { externalTargetCopy, type FileExternalOpen } from "./useFileExternalOpen";

type FileEditorSlot = ComponentProps<typeof FileEditorDefaultNotice>["slot"];

export interface FilePaneToolbarProps {
  panelId: string;
  filePath: string;
  fileName: string | undefined;
  displayPath: string;
  isMarkdown: boolean;
  viewMode: FileViewMode;
  /** One entry per available mode; the toggle shows only when there is a choice. */
  toggleOptions: Array<{ value: FileViewMode; label: string }>;
  modeToggleRef: RefObject<HTMLDivElement | null>;
  onViewModeChange: (mode: FileViewMode) => void;
  editorPicker: FileEditorPickerModel | null;
  pinnedEditor: string | undefined;
  setEditorChoice: FileEditorChoice["setEditorChoice"];
  effectiveDiffWrapLines: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  copyableContents: string | null;
  revealWorktreeId: string;
  reveal: RevealCopy;
  openTarget: "browser" | "editor";
  savesPageInstead: boolean;
  onRunOpenTarget: () => void;
  externalOpen: FileExternalOpen;
  /** The default editor slot still waiting on the user's answer, if one is on offer here. */
  defaultNoticeSlot: FileEditorSlot | null;
  onDefaultAnswered: (choice: ProjectSurfaceChoice) => void;
  /** The text the "Edit" invitation banner offers to edit, or null when it isn't offered. */
  editorBannerContent: string | null;
  showDiffStale: boolean;
  onRetryDiff: () => void;
}

/**
 * The file pane's toolbar row and the banners that hang under it. Every action
 * aims at the file the pane is showing; the pane owns what each one does.
 */
export function FilePaneToolbar({
  panelId,
  filePath,
  fileName,
  displayPath,
  isMarkdown,
  viewMode,
  toggleOptions,
  modeToggleRef,
  onViewModeChange,
  editorPicker,
  pinnedEditor,
  setEditorChoice,
  effectiveDiffWrapLines,
  refreshing,
  onRefresh,
  copyableContents,
  revealWorktreeId,
  reveal,
  openTarget,
  savesPageInstead,
  onRunOpenTarget,
  externalOpen,
  defaultNoticeSlot,
  onDefaultAnswered,
  editorBannerContent,
  showDiffStale,
  onRetryDiff,
}: FilePaneToolbarProps) {
  const setFileEditorChoice = usePanelStore((state) => state.setFileEditorChoice);
  const markdownWrapLines = usePreferencesStore((state) => state.markdownWrapLines);
  const setMarkdownWrapLines = usePreferencesStore((state) => state.setMarkdownWrapLines);
  const markdownFontSize = usePreferencesStore((state) => state.markdownFontSize);
  const setMarkdownFontSize = usePreferencesStore((state) => state.setMarkdownFontSize);
  const setDiffWrapLines = usePreferencesStore((state) => state.setDiffWrapLines);

  const {
    externalError,
    dismissExternalError,
    handleOpenExternal,
    isErrorTargetPending,
    showRetrySpinner,
  } = externalOpen;
  const errorCopy = externalError ? externalTargetCopy(externalError.target, reveal) : null;
  const showMarkdownWrap = (isMarkdown && viewMode === "source") || viewMode === "edit";

  return (
    <>
      <FileViewerToolbar.Root
        label="File viewer controls"
        // Where the secondary actions fold into "More actions" — the same
        // priority rule as the file browser's viewer: the mode control and
        // the file's name keep their room, the icon row gives way first. A
        // row with a mode toggle folds earlier, because the toggle alone
        // takes ~120px.
        compactBelow={toggleOptions.length > 1 ? 500 : 360}
      >
        {toggleOptions.length > 1 && (
          <div ref={modeToggleRef} className="contents">
            <FileViewerToolbar.ModeControl<FileViewMode>
              options={toggleOptions}
              value={viewMode}
              onChange={onViewModeChange}
            />
          </div>
        )}
        {editorPicker && (
          <FileEditorPicker
            label={editorPicker.label}
            options={editorPicker.options}
            value={editorPicker.value}
            onChange={(choice) => {
              // A pinned panel follows its own pick; the answer for the type
              // is remembered either way.
              if (viewMode === "edit" && pinnedEditor !== undefined) {
                setFileEditorChoice(panelId, choice);
              }
              void setEditorChoice(editorPicker.choiceKey, choice);
            }}
          />
        )}
        <FileViewerToolbar.Path
          path={displayPath}
          icon={getFileTypeIcon(fileName ?? filePath).Icon}
          copyText={filePath || null}
        />
        <FileViewerToolbar.Actions>
          <FileViewerToolbar.Responsive
            wide={
              <>
                {/* The mirror of Wrap below it: each owns the slot in the mode
                    it applies to, so rendered and source both carry exactly
                    one markdown-specific control rather than a row that grows. */}
                {isMarkdown && viewMode === "rendered" && (
                  <MarkdownTextSizeControl
                    value={markdownFontSize}
                    onValueChange={setMarkdownFontSize}
                    data-testid="file-pane-text-size"
                  />
                )}
                {showMarkdownWrap && (
                  <FileViewerToolbar.IconButton
                    label="Wrap long lines"
                    pressed={markdownWrapLines}
                    onClick={() => setMarkdownWrapLines(!markdownWrapLines)}
                  >
                    <WrapText className={TOOLBAR_ICON_CLASS} />
                  </FileViewerToolbar.IconButton>
                )}
                {/* Diff mode's own wrap, on the shared `diffWrapLines` the diff
                    panel writes — not the markdown one above it, which only
                    ever applied to Source view. Ungated by file type: the diff
                    below renders as text for every file. */}
                {viewMode === "diff" && (
                  <FileViewerToolbar.IconButton
                    label="Wrap long lines"
                    pressed={effectiveDiffWrapLines}
                    onClick={() => setDiffWrapLines(!effectiveDiffWrapLines)}
                  >
                    <WrapText className={TOOLBAR_ICON_CLASS} />
                  </FileViewerToolbar.IconButton>
                )}
                {/* Refresh follows what's on screen — re-reading the file
                    wouldn't refetch a diff, and vice versa. */}
                <FileViewerToolbar.IconButton label="Refresh" onClick={onRefresh}>
                  <SpinningIcon
                    icon={RefreshCw}
                    active={refreshing}
                    className={TOOLBAR_ICON_CLASS}
                  />
                </FileViewerToolbar.IconButton>
                {/* The raw file text, whichever view mode is showing: rendered
                    markdown and the diff view both copy the source. `content`
                    only ever holds a settled read, so the button is absent
                    while one is in flight and for every state with no text.
                    Keyed on the path so the confirmation resets when a file is
                    swapped for one whose contents happen to be identical. */}
                <FileViewerToolbar.CopyContentsButton key={filePath} contents={copyableContents} />
                {/* The route back to the tree this file was opened from.
                    Offered only when a live worktree contains the file. */}
                {revealWorktreeId && (
                  <FileViewerToolbar.IconButton
                    label="Show in file browser"
                    onClick={() => void handleOpenExternal("file-browser")}
                  >
                    <FolderTree className={TOOLBAR_ICON_CLASS} />
                  </FileViewerToolbar.IconButton>
                )}
                {/* Reveal is always offered, even for a file the viewer can't
                    render — the OS file manager is then the only way forward. */}
                <FileViewerToolbar.IconButton
                  label={reveal.label}
                  onClick={() => void handleOpenExternal("reveal")}
                >
                  <FolderOpen className={TOOLBAR_ICON_CLASS} />
                </FileViewerToolbar.IconButton>
                <FileViewerToolbar.IconButton
                  label={
                    savesPageInstead
                      ? saveHostFileLabel()
                      : openTarget === "browser"
                        ? "Open in browser"
                        : "Open in editor"
                  }
                  onClick={onRunOpenTarget}
                >
                  {savesPageInstead ? (
                    <Download className={TOOLBAR_ICON_CLASS} />
                  ) : openTarget === "browser" ? (
                    <Globe className={TOOLBAR_ICON_CLASS} />
                  ) : (
                    <ExternalLink className={TOOLBAR_ICON_CLASS} />
                  )}
                </FileViewerToolbar.IconButton>
              </>
            }
            narrow={
              <>
                {/* Refresh stays out of the fold: its spinner is the only
                  progress this pane shows, and a closed menu can't spin. */}
                <FileViewerToolbar.IconButton label="Refresh" onClick={onRefresh}>
                  <SpinningIcon
                    icon={RefreshCw}
                    active={refreshing}
                    className={TOOLBAR_ICON_CLASS}
                  />
                </FileViewerToolbar.IconButton>
                <FileViewerToolbar.MoreActions data-testid="file-pane-more-actions">
                  {isMarkdown && viewMode === "rendered" && (
                    <>
                      <MarkdownTextSizeMenuItems
                        value={markdownFontSize}
                        onValueChange={setMarkdownFontSize}
                      />
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {(showMarkdownWrap || viewMode === "diff") && (
                    <>
                      <DropdownMenuCheckboxItem
                        checked={viewMode === "diff" ? effectiveDiffWrapLines : markdownWrapLines}
                        onCheckedChange={(checked) =>
                          viewMode === "diff"
                            ? setDiffWrapLines(checked)
                            : setMarkdownWrapLines(checked)
                        }
                      >
                        Wrap long lines
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {copyableContents !== null && (
                    <DropdownMenuItem
                      onSelect={() => copyWithToast("File contents", copyableContents)}
                    >
                      <Copy className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
                      Copy file contents
                    </DropdownMenuItem>
                  )}
                  {revealWorktreeId && (
                    <DropdownMenuItem onSelect={() => void handleOpenExternal("file-browser")}>
                      <FolderTree className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
                      Show in file browser
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => void handleOpenExternal("reveal")}>
                    <FolderOpen className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
                    {reveal.label}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onRunOpenTarget}>
                    {savesPageInstead ? (
                      <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
                    ) : openTarget === "browser" ? (
                      <Globe className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
                    ) : (
                      <ExternalLink
                        className="mr-2 h-3.5 w-3.5"
                        aria-hidden="true"
                        data-menu-icon
                      />
                    )}
                    {savesPageInstead
                      ? saveHostFileLabel()
                      : openTarget === "browser"
                        ? "Open in browser"
                        : "Open in editor"}
                  </DropdownMenuItem>
                </FileViewerToolbar.MoreActions>
              </>
            }
          />
        </FileViewerToolbar.Actions>
      </FileViewerToolbar.Root>
      {/* Only where the default's editor is on offer for this file — not one
          too large for it — so the one question lands in a pane that can show
          what it asks about. */}
      {defaultNoticeSlot !== null && (
        <FileEditorDefaultNotice slot={defaultNoticeSlot} onAnswered={onDefaultAnswered} />
      )}
      {editorBannerContent !== null && (
        <FileEditorBanner
          key={`${panelId}:${filePath}`}
          filePath={filePath}
          content={editorBannerContent}
          onEdit={() => onViewModeChange("edit")}
        />
      )}
      {showDiffStale && (
        <InlineStatusBanner
          severity="info"
          icon={FileDiffIcon}
          title="File changed since this diff loaded"
          role="status"
          ariaLive="polite"
          action={{ id: "refresh-diff", label: "Refresh", icon: RefreshCw, onClick: onRetryDiff }}
        />
      )}
      {externalError && errorCopy && (
        <InlineStatusBanner
          icon={XCircle}
          title={errorCopy.errorTitle}
          description={externalError.message}
          severity="error"
          action={{
            id: "retry-open-external",
            label: "Retry",
            icon: RefreshCw,
            variant: "dangerFilled",
            loading: showRetrySpinner,
            disabled: isErrorTargetPending,
            onClick: () => void handleOpenExternal(externalError.target),
            ariaLabel: errorCopy.retryAriaLabel,
          }}
          onClose={dismissExternalError}
          closeAriaLabel={errorCopy.dismissAriaLabel}
        />
      )}
    </>
  );
}
