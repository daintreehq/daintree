import { Fragment, useCallback, useMemo } from "react";
import type React from "react";
import { Copy, ExternalLink, FileDiff } from "lucide-react";
import { AtSign, FileText, FolderOpen, Folders, Package } from "@/components/icons";
import {
  ContextMenuActionItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuMeta,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import {
  usePluginContextMenuItems,
  type PluginContextMenuItemEntry,
} from "@/hooks/usePluginContextMenuItems";
import {
  useInsertFileReference,
  type InsertFileReferenceRefusalReason,
} from "@/hooks/useInsertFileReference";
import { copyContextWithFeedback } from "@/hooks/useWorktreeActions";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { isFileContentsCopyCandidate } from "@/components/FileViewer/filePreviewKinds";
import { INSERT_FILE_REFERENCE_COMBO } from "@/panels/file-browser/fileReference";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import type { BuiltInRuntimeActionId } from "@shared/config/actionIds";
import type { CopyTreeRunSource, GitStatus } from "@shared/types";

const ICON_CLASS = "w-3.5 h-3.5 mr-2";

const INSERT_LABEL = "Insert file reference";

/**
 * Why the row can't insert a reference, in the two registers the menu needs.
 *
 * `meta` is the trailing muted slot a sighted user reads; `detail` is folded
 * into the item's accessible name because `ContextMenuMeta` is `aria-hidden`,
 * so the visible reason would otherwise be silent to a screen reader. One
 * entry per gate: a single "nothing resolved" is what made the item read as
 * broken rather than conditional (#12207).
 */
const INSERT_REFUSAL_COPY = {
  "workspace-unavailable": { meta: "No workspace", detail: "no workspace" },
  "fleet-broadcast-armed": { meta: "Fleet armed", detail: "the fleet is armed" },
  "hybrid-input-disabled": { meta: "Input bar off", detail: "the hybrid input bar is off" },
  // One string for `disconnected` and `recovering` alike. The distinction that
  // matters — wait, or act — is already on screen: `HostCrashBanner` renders
  // for every non-connected status and says which, so a menu row repeating it
  // in four words could only get it wrong.
  "backend-unavailable": {
    meta: "No terminal service",
    detail: "the terminal service is unavailable",
  },
  "recorded-target-unavailable": {
    meta: "Agent unavailable",
    detail: "that agent can't take input",
  },
  // Deliberately not "no agent in the grid": this also fires when agents are
  // there but none can take input — locked, restarting, mid-voice-submit — and
  // naming the grid would then be false.
  "no-eligible-agent": { meta: "No agent available", detail: "no agent is available" },
  "multiple-eligible-agents": { meta: "Type to an agent", detail: "type to an agent first" },
} as const satisfies Record<InsertFileReferenceRefusalReason, { meta: string; detail: string }>;

/**
 * Dispatch an action for the clicked row and, if it fails, say so with a Retry
 * that re-runs the same call.
 *
 * Shared rather than written per handler because the failure mode is shared:
 * the menu has already closed by the time a dispatch settles, so anything that
 * goes wrong here is invisible without a toast — the entry was deleted between
 * listing and click, the file turned out to be binary. A second copy of this
 * shape is how one of these handlers ends up silently swallowing its errors.
 *
 * Module scope, not a `useCallback`: it closes over nothing from the hook, so
 * the handlers below can depend on it without a memo of its own.
 */
function runRowAction<Result>(
  actionId: BuiltInRuntimeActionId,
  args: Record<string, string>,
  errorTitle: string,
  onSuccess?: (result: Result) => void
): void {
  const run = async () => {
    const result = await actionService.dispatch<Result>(actionId, args, {
      source: "context-menu",
    });
    if (!result.ok) {
      notify({
        type: "error",
        title: errorTitle,
        message: result.error.message,
        action: { label: "Retry", onClick: () => void run() },
      });
      return;
    }
    onSuccess?.(result.result);
  };
  void run();
}

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
 *
 * The root is the direct actions only — the opens, reveal, insert — with the
 * copies and the plugin contributions nested (#12206). That keeps it the same
 * height on every row and with any number of plugins installed, so the folder
 * prefix reads as the first group of one menu rather than as a lid on a
 * ten-item column.
 */
export function useFileRowMenuItems(surface: FileRowMenuSurface): FileRowMenuController {
  const { worktreePath, worktreeId, copyTreeRunSource } = surface;
  const filePluginItems = usePluginContextMenuItems("file");
  const { canInsert, refusalReason, insert } = useInsertFileReference();
  // Narrowed here, where the discriminated pair still correlates, and reduced
  // to two primitives so `renderItems` keeps a stable dependency list.
  // `undefined` rather than `null` for the absent case: that is what a DOM
  // attribute prop takes to mean "don't render me".
  const insertRefusalMeta = canInsert ? undefined : INSERT_REFUSAL_COPY[refusalReason].meta;
  const insertRefusalLabel = canInsert
    ? undefined
    : `${INSERT_LABEL}, ${INSERT_REFUSAL_COPY[refusalReason].detail}`;

  // Bucketed here rather than in `renderItems`: that runs once per row, and a
  // Review Hub listing thousands of changed files would rebuild the same map
  // for every one of them. Insertion order is the plugins' contribution order,
  // so the submenu doesn't reshuffle between renders.
  const pluginGroups = useMemo(() => {
    const byPluginId = new Map<string, PluginContextMenuItemEntry[]>();
    for (const entry of filePluginItems) {
      const bucket = byPluginId.get(entry.pluginId);
      if (bucket) bucket.push(entry);
      else byPluginId.set(entry.pluginId, [entry]);
    }
    return [...byPluginId.entries()];
  }, [filePluginItems]);

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

  const handleCopyFileContents = useCallback(
    (absolutePath: string) =>
      // `file.read`, not filesClient: the action resolves the path against the
      // project and its worktrees and refuses anything outside them, and reports
      // binary, oversized and LFS-pointer files as named failures rather than
      // handing back partial text. The extension gate on the item only hides
      // what it can recognise, so this is the check that actually holds.
      runRowAction<{ content: string }>(
        "file.read",
        { path: absolutePath },
        "Couldn't copy file contents",
        // Written straight off the read: clipboard writes want a fresh
        // transient activation, and parking the text in state first would put a
        // render between the gesture and the write for no gain.
        (result) => copyToClipboard(result.content, "Couldn't copy file contents")
      ),
    [copyToClipboard]
  );

  const handleReveal = useCallback(
    (absolutePath: string) =>
      runRowAction("file.showItemInFolder", { path: absolutePath }, reveal.errorTitle),
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
      // A deleted file is still listed — the change set would be a lie without
      // it — but there is nothing on disk to open, so the two "show me the
      // current content" items would resolve to a file-not-found. Its diff is
      // exactly what the user wants here and stays. Same call the file browser
      // already makes for its viewer selection (`isSelectedChangedFile`).
      const showOpenCurrent = !isDirectory && status !== "deleted";
      // Rides the same "there is a current file on disk" gate, then drops the
      // kinds with no text to put on a clipboard. Extension-only by necessity —
      // nothing here has read the file — so an unfamiliar binary still shows
      // the item and fails at the read with a reason.
      const showCopyFileContents = showOpenCurrent && isFileContentsCopyCandidate(absolutePath);

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
          {showOpenCurrent && (
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
          <ContextMenuItem onSelect={() => handleReveal(absolutePath)}>
            <FolderOpen className={ICON_CLASS} />
            {reveal.label}
          </ContextMenuItem>
          {/* Disabled rather than hidden when nothing resolves: the gesture is
              the point of the menu entry, and a row that silently drops it
              would read as broken. The reason rides along so the row accounts
              for itself — seven different gates used to share one grey item
              (#12207). It takes the trailing slot from the shortcut hint
              rather than sitting beside it: two `ml-auto` siblings split the
              free space into two ragged columns, and advertising a keybinding
              on an item that cannot run is the same lie `aria-keyshortcuts`
              already declines to tell. */}
          <ContextMenuItem
            onSelect={() => insert(absolutePath)}
            disabled={!canInsert}
            {...(canInsert
              ? { "aria-keyshortcuts": insertAriaKeyshortcuts }
              : { "aria-label": insertRefusalLabel })}
          >
            <AtSign className={ICON_CLASS} />
            {INSERT_LABEL}
            {canInsert ? (
              <ContextMenuShortcut>{insertShortcutHint}</ContextMenuShortcut>
            ) : (
              <ContextMenuMeta>{insertRefusalMeta}</ContextMenuMeta>
            )}
          </ContextMenuItem>
          {/* Reveal and Insert render unconditionally, so the direct-action
              block above is never empty and this separator never leads. */}
          <ContextMenuSeparator />
          {/* Nested for the same reason the worktree card nests its own Copy:
              four near-identical rows read as one choice, not four, and the
              root stays the length of the things the menu is actually opened
              for. Always present — the three path copies never gate. */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Copy className={ICON_CLASS} />
              Copy
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {/* First and set apart, mirroring the worktree card: this runs
                  CopyTree over the row, it does not put a string on the
                  clipboard. Always enabled for a worktree — the row's ignore
                  status isn't known here, and CopyTree still applies its own
                  .gitignore-aware discovery (reporting when nothing was
                  eligible), so this stays safe for an ignored path. Absent for
                  a workspace root, where CopyTree is worktree-scoped and it
                  would be a dead item (#11482). */}
              {worktreeId !== null && (
                <>
                  <ContextMenuItem onSelect={() => handleCopyContext(target)}>
                    <Folders className={ICON_CLASS} />
                    Copy context
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
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
              {showCopyFileContents && (
                <ContextMenuItem onSelect={() => handleCopyFileContents(absolutePath)}>
                  <Copy className={ICON_CLASS} />
                  Copy file contents
                </ContextMenuItem>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {/* Plugins reach every file surface through this one submenu, or none
              of them (#11757). Nested so the root is the same height whatever
              is installed, and grouped by plugin so two extensions offering
              similarly named items stay tellable apart — the same shape the
              worktree card's Extensions uses. Rendered only when something
              contributes: an empty submenu is a dead end. */}
          {pluginGroups.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Package className={ICON_CLASS} />
                  Extensions
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {pluginGroups.map(([pluginId, entries], groupIndex) => (
                    <Fragment key={pluginId}>
                      {pluginGroups.length > 1 && groupIndex > 0 && <ContextMenuSeparator />}
                      {pluginGroups.length > 1 && <ContextMenuLabel>{pluginId}</ContextMenuLabel>}
                      {/* Still the shared section, one call per group: it owns
                          the action source, the namespaced keys and the
                          dispatch, and a second copy of that here is how the
                          two drift. The separators are the shell's now, so it
                          renders none. The dispatched args name the clicked
                          file so a plugin item receives its subject rather than
                          `undefined`. */}
                      <PluginContextMenuSection
                        items={entries}
                        leadingSeparator={false}
                        dispatchArgs={{
                          path: absolutePath,
                          ...(worktreePath && { worktreePath }),
                          ...(status && { status }),
                        }}
                      />
                    </Fragment>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            </>
          )}
        </>
      );
    },
    [
      worktreePath,
      worktreeId,
      pluginGroups,
      canInsert,
      insertRefusalMeta,
      insertRefusalLabel,
      insert,
      insertAriaKeyshortcuts,
      insertShortcutHint,
      reveal,
      copyToClipboard,
      handleCopyContext,
      handleCopyFileContents,
      handleReveal,
    ]
  );

  return { renderItems, canInsertFileReference: canInsert, insertFileReference: insert };
}
