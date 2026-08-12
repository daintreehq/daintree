import { useCallback, useMemo } from "react";
import type React from "react";
import { Copy, ExternalLink, FileDiff } from "lucide-react";
import { AtSign, FileText, FolderOpen, Folders } from "@/components/icons";
import {
  ContextMenuActionItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import { useInsertFileReference } from "@/hooks/useInsertFileReference";
import { copyContextWithFeedback } from "@/hooks/useWorktreeActions";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { INSERT_FILE_REFERENCE_COMBO } from "@/panels/file-browser/fileReference";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import type { CopyTreeRunSource, GitStatus } from "@shared/types";

const ICON_CLASS = "w-3.5 h-3.5 mr-2";

/**
 * The file a row's context menu acts on. Every path is passed in rather than
 * derived: `relativePath` means "relative to the worktree root" on every
 * surface, but each one already holds it in a different shape — the file
 * browser's row path stays root-relative even when the tree is re-rooted to a
 * subfolder, while the changed-files list carries `change.relativePath` beside
 * a `change.path` that may already be absolute. Re-deriving here would either
 * double-prefix one of them or strip a root off the other.
 */
export interface FileRowMenuTarget {
  /** Absolute path on disk — what every action and the clipboard's "Copy path" use. */
  absolutePath: string;
  /** Path relative to the worktree root. */
  relativePath: string;
  /** Base name, for "Copy file name". */
  name: string;
  isDirectory: boolean;
  /** Git status when the row is a known change; `null` when it has none. */
  status: GitStatus | null;
}

export interface FileRowMenuItemOptions {
  /**
   * Opens this row's diff. Supplied by surfaces that already own a
   * changeset-aware diff opener, so the menu lands on the same panel a plain
   * click would — never a second diff path. Omitted surfaces fall back to the
   * `file.openDiff` action.
   */
  onOpenDiff?: (() => void) | undefined;
  /**
   * Whether the row has changes to diff. Independent of `onOpenDiff`: the file
   * browser lists unchanged files and has no diff to show for them.
   */
  hasChanges?: boolean;
}

export interface FileRowMenuSurface {
  /** Worktree root the rows belong to. Empty string when none resolves. */
  worktreePath: string;
  /**
   * Worktree the rows belong to. `null` for a workspace-rooted surface, which
   * drops `Copy context` — CopyTree is worktree-scoped, so it would be a dead
   * item there (#11482).
   */
  worktreeId: string | null;
  /**
   * Which surface a CopyTree run came from, for its history entry. Omitted by
   * surfaces the enum doesn't name — `COPY_TREE_RUN_SOURCES` records real
   * surfaces, and picking the nearest wrong one would poison the history.
   */
  copyTreeRunSource?: CopyTreeRunSource | undefined;
}

export interface FileRowMenuController {
  /** The canonical file-row menu for one row. Render inside a `ContextMenuContent`. */
  renderItems: (target: FileRowMenuTarget, options?: FileRowMenuItemOptions) => React.ReactNode;
  /** False when no agent is available — the menu item disables and shortcuts no-op. */
  canInsertFileReference: boolean;
  /** Writes an `@file` reference to the resolved agent's draft. */
  insertFileReference: (absolutePath: string) => boolean;
}

/**
 * Stops a file row's `contextmenu` from reaching an enclosing trigger.
 *
 * Radix's `ContextMenu.Trigger` calls `preventDefault()` but never
 * `stopPropagation()`, and neither does our wrapper — so a row trigger nested
 * inside the worktree card's card-wide trigger lets the event bubble on and the
 * card's menu opens over the row's. The innermost object owns the menu
 * (#11757), and this is what enforces it. `preventDefault()` is deliberately
 * NOT called: Radix composes this handler ahead of its own and skips that one
 * when the default was prevented, which would stop the row's own menu opening.
 */
export function stopFileRowMenuPropagation(event: React.MouseEvent): void {
  event.stopPropagation();
}

/**
 * Opens a file row's context menu from the keyboard, anchored to the row.
 *
 * Radix's ContextMenu derives its position from the `contextmenu` event and has
 * no imperative open, so the Menu key and Shift+F10 are replayed as a synthetic
 * event on the row's own node. Returns false when there is no row to anchor to,
 * leaving the keypress for whoever else wants it.
 */
export function openFileRowMenuFromKeyboard(row: HTMLElement | null): boolean {
  if (row === null) return false;
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + rect.height / 2,
    })
  );
  return true;
}

/** Whether a keyboard event is the "open the context menu" gesture. */
export function isFileRowMenuKey(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.key === "ContextMenu") return true;
  return event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * The one file-row context menu, shared by every surface that lists files
 * (#11757): the worktree card's changed files, the file browser's tree and
 * folder listing, the Review Hub's staging rows, and the diff file sidebar.
 *
 * Called once per surface — never per row. It subscribes to the panel and
 * plugin stores, and a Review Hub listing thousands of changed files would
 * otherwise mint one subscription per row. `renderItems` is the pure part that
 * runs per row.
 *
 * Surfaces render their own prefix section above these items (the file
 * browser's `Show contents` / `Set as root` for a folder); the core itself is
 * identical everywhere, so a file never gains or loses `Copy path` by which
 * panel it happens to be listed in.
 */
export function useFileRowMenuItems(surface: FileRowMenuSurface): FileRowMenuController {
  const { worktreePath, worktreeId, copyTreeRunSource } = surface;
  const filePluginItems = usePluginContextMenuItems("file");
  const { canInsert, insert } = useInsertFileReference();

  const reveal = useMemo(() => revealCopy(), []);
  const insertShortcutHint = isMac() ? "⌘I" : "Ctrl+I";
  const insertAriaKeyshortcuts = comboToAriaKeyshortcuts(INSERT_FILE_REFERENCE_COMBO, isMac());

  const copyToClipboard = useCallback((text: string, errorTitle: string) => {
    const write = () =>
      navigator.clipboard.writeText(text).catch((error: unknown) => {
        // A silent failure leaves the previous clipboard contents in place,
        // and the user's next paste would be the wrong value.
        notify({
          type: "error",
          title: errorTitle,
          message:
            error instanceof Error && error.name === "NotAllowedError"
              ? "The clipboard is unavailable while another app holds it."
              : "The clipboard rejected the write.",
          action: { label: "Retry", onClick: () => void write() },
        });
      });
    void write();
  }, []);

  const handleReveal = useCallback(
    (absolutePath: string) => {
      const run = async () => {
        const result = await actionService.dispatch(
          "file.showItemInFolder",
          { path: absolutePath },
          { source: "context-menu" }
        );
        // The menu has already closed by the time this settles, so a failure
        // here is invisible without a toast — e.g. the entry was deleted
        // between listing and click.
        if (!result.ok) {
          notify({
            type: "error",
            title: reveal.errorTitle,
            message: result.error.message,
            action: { label: "Retry", onClick: () => void run() },
          });
        }
      };
      void run();
    },
    [reveal]
  );

  const handleCopyContext = useCallback(
    (target: FileRowMenuTarget) => {
      if (worktreeId === null) return;
      // Literal path, not a pattern: scoping keeps the worktree's ignore rules
      // in play, so the row yields what a whole-worktree copy would have.
      void copyContextWithFeedback(
        worktreeId,
        "context-menu",
        {
          scopePaths: [target.relativePath],
          scopeKind: target.isDirectory ? "folder" : "file",
        },
        copyTreeRunSource
      );
    },
    [worktreeId, copyTreeRunSource]
  );

  const renderItems = useCallback(
    (target: FileRowMenuTarget, options?: FileRowMenuItemOptions): React.ReactNode => {
      const { absolutePath, relativePath, name, isDirectory, status } = target;
      // A folder has no diff, nothing for the file viewer to render, and no
      // line for an editor to land on. Hiding the three rather than disabling
      // them keeps the menu scope-honest: the surface's own folder prefix is
      // what a directory row is meant to act through.
      const showOpenDiff = !isDirectory && (options?.hasChanges ?? status !== null);

      return (
        <>
          {showOpenDiff &&
            (options?.onOpenDiff ? (
              <ContextMenuItem onSelect={options.onOpenDiff}>
                <FileDiff className={ICON_CLASS} />
                Open diff
              </ContextMenuItem>
            ) : (
              <ContextMenuActionItem
                actionId="file.openDiff"
                args={{
                  path: absolutePath,
                  ...(worktreePath && { worktreePath }),
                  ...(status && { status }),
                }}
              >
                <FileDiff className={ICON_CLASS} />
                Open diff
              </ContextMenuActionItem>
            ))}
          {!isDirectory && (
            <>
              <ContextMenuActionItem actionId="file.view" args={{ path: absolutePath }}>
                <FileText className={ICON_CLASS} />
                Open file
              </ContextMenuActionItem>
              <ContextMenuActionItem actionId="file.openInEditor" args={{ path: absolutePath }}>
                <ExternalLink className={ICON_CLASS} />
                Open in editor
              </ContextMenuActionItem>
            </>
          )}
          {!isDirectory && <ContextMenuSeparator />}
          {/* Disabled rather than hidden when nothing resolves: the gesture is
              the point of the menu entry, and a row that silently drops it
              would read as broken. The agent is resolved from typing history,
              so this is off until the user has actually talked to one. */}
          <ContextMenuItem
            onSelect={() => insert(absolutePath)}
            disabled={!canInsert}
            {...(canInsert ? { "aria-keyshortcuts": insertAriaKeyshortcuts } : {})}
          >
            <AtSign className={ICON_CLASS} />
            Insert file reference
            <ContextMenuShortcut>{insertShortcutHint}</ContextMenuShortcut>
          </ContextMenuItem>
          {/* Always enabled for a worktree: the row's ignore status isn't known
              here, and CopyTree still applies its own .gitignore-aware
              discovery (reporting when nothing was eligible), so this stays
              safe for an ignored path. Absent for a workspace root — CopyTree
              is worktree-scoped, so leaving it on would be a dead item
              (#11482). */}
          {worktreeId !== null && (
            <ContextMenuItem onSelect={() => handleCopyContext(target)}>
              <Folders className={ICON_CLASS} />
              Copy context
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copyToClipboard(absolutePath, "Couldn't copy path")}>
            <Copy className={ICON_CLASS} />
            Copy path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copyToClipboard(relativePath, "Couldn't copy path")}>
            <Copy className={ICON_CLASS} />
            Copy relative path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copyToClipboard(name, "Couldn't copy file name")}>
            <Copy className={ICON_CLASS} />
            Copy file name
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleReveal(absolutePath)}>
            <FolderOpen className={ICON_CLASS} />
            {reveal.label}
          </ContextMenuItem>
          {/* Plugins reach every file surface through this one section, or
              none of them (#11757). The dispatched args name the clicked file
              so a plugin item receives its subject rather than `undefined`. */}
          <PluginContextMenuSection
            items={filePluginItems}
            dispatchArgs={{
              path: absolutePath,
              ...(worktreePath && { worktreePath }),
              ...(status && { status }),
            }}
          />
        </>
      );
    },
    [
      worktreePath,
      worktreeId,
      filePluginItems,
      canInsert,
      insert,
      insertAriaKeyshortcuts,
      insertShortcutHint,
      reveal,
      copyToClipboard,
      handleCopyContext,
      handleReveal,
    ]
  );

  return { renderItems, canInsertFileReference: canInsert, insertFileReference: insert };
}
