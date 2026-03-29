import { useCallback, useMemo, useState } from "react";
import type React from "react";
import type { Terminal as XTermTerminal } from "@xterm/xterm";
import { type TerminalLocation, type TerminalType } from "@/types";
import { useTerminalStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useWorktrees } from "@/hooks/useWorktrees";
import { AGENT_IDS, getAgentConfig } from "@/config/agents";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";
import { actionService } from "@/services/ActionService";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import {
  ArrowDownFromLine,
  Bell,
  BellOff,
  Clipboard,
  Copy,
  CopyPlus,
  ExternalLink,
  Globe,
  Info,
  Link,
  Lock,
  Maximize2,
  NotebookPen,
  Minimize2,
  OctagonX,
  Pencil,
  Play,
  RefreshCw,
  Repeat2,
  RotateCcw,
  Search,
  Send,
  SquareTerminal,
  Trash2,
  Unlock,
} from "lucide-react";
import { MoveToDockIcon, MoveToGridIcon, CanopyAgentIcon, WorktreeIcon } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

const URL_REGEX = /(?:https?|ftp):\/\/[^\s"'<>()[\]{}]+/g;

export function extractUrlAtPoint(
  terminal: XTermTerminal,
  clientX: number,
  clientY: number
): string | null {
  const el = terminal.element;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom)
    return null;
  const col = Math.floor(((clientX - rect.left) / rect.width) * terminal.cols);
  const row = Math.floor(((clientY - rect.top) / rect.height) * terminal.rows);
  if (row < 0 || row >= terminal.rows || col < 0 || col >= terminal.cols) return null;
  const bufferRow = terminal.buffer.active.viewportY + row;
  const line = terminal.buffer.active.getLine(bufferRow);
  if (!line) return null;
  const text = line.translateToString(true);
  URL_REGEX.lastIndex = 0;
  let match;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:!?'")\]]+$/, "");
    if (col >= match.index && col < match.index + url.length) {
      return url;
    }
  }
  return null;
}

export interface CreateNoteArgs {
  title: string;
  content: string;
  scope: "worktree" | "project";
  worktreeId?: string;
}

export function buildCreateNoteArgs(
  agentName: string,
  worktreeName: string | undefined,
  selectionText: string,
  worktreeId: string | undefined
): CreateNoteArgs {
  const timestamp = new Date().toLocaleString();
  const title = `Note from ${agentName} — ${timestamp}`;

  const lines: string[] = [];
  lines.push(`**Agent:** ${agentName}`);
  if (worktreeName) lines.push(`**Worktree:** ${worktreeName}`);
  lines.push(`**Time:** ${timestamp}`);

  if (selectionText) {
    lines.push("");
    lines.push(
      selectionText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    );
  }

  return {
    title,
    content: lines.join("\n"),
    scope: worktreeId ? "worktree" : "project",
    worktreeId,
  };
}

interface TerminalContextMenuProps {
  terminalId: string;
  children: React.ReactNode;
  forceLocation?: TerminalLocation;
}

/**
 * Right-click context menu for panel headers (terminal, agent, browser, notes, dev-preview).
 * Used by both DockedTerminalItem and PanelHeader.
 */
export function TerminalContextMenu({
  terminalId,
  children,
  forceLocation,
}: TerminalContextMenuProps) {
  const terminal = useTerminalStore(
    useShallow((state) => state.terminals.find((t) => t.id === terminalId))
  );
  const maximizeTarget = useTerminalStore((s) => s.maximizeTarget);
  const getPanelGroup = useTerminalStore((s) => s.getPanelGroup);

  const isMaximized = useMemo(() => {
    if (!maximizeTarget) return false;
    if (maximizeTarget.type === "panel") {
      return maximizeTarget.id === terminalId;
    } else {
      const group = getPanelGroup(terminalId);
      return group?.id === maximizeTarget.id;
    }
  }, [maximizeTarget, terminalId, getPanelGroup]);

  const { worktrees } = useWorktrees();

  const isWatched = useTerminalStore((state) => state.watchedPanels.has(terminalId));

  const [hasSelection, setHasSelection] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const managed = terminalInstanceService.get(terminalId);
      if (!managed?.terminal) {
        setHasSelection(false);
        setHoveredUrl(null);
        return;
      }
      const selection = managed.terminal.getSelection();
      setHasSelection(!!selection);
      setSelectionText(selection);
      setHoveredUrl(extractUrlAtPoint(managed.terminal, e.clientX, e.clientY));
    },
    [terminalId]
  );

  const isPaused = terminal?.flowStatus === "paused-backpressure";

  const currentLocation: TerminalLocation = forceLocation ?? terminal?.location ?? "grid";

  const isMac = navigator.platform.toLowerCase().includes("mac");
  const modifierKey = isMac ? "⌘" : "Ctrl";

  const handleAction = useCallback(
    (actionId: string) => {
      if (!terminal) return;

      if (actionId.startsWith("open-link:")) {
        const url = actionId.slice("open-link:".length);
        void actionService.dispatch("system.openExternal", { url }, { source: "context-menu" });
        return;
      }

      if (actionId.startsWith("copy-link:")) {
        const url = actionId.slice("copy-link:".length);
        void actionService.dispatch("terminal.copyLink", { url }, { source: "context-menu" });
        return;
      }

      if (actionId.startsWith("move-to-worktree:")) {
        const worktreeId = actionId.slice("move-to-worktree:".length);
        void actionService.dispatch(
          "terminal.moveToWorktree",
          { terminalId, worktreeId },
          { source: "context-menu" }
        );
        return;
      }

      if (actionId.startsWith("convert-to:")) {
        const targetType = actionId.slice("convert-to:".length);
        if (targetType === "terminal" || AGENT_IDS.includes(targetType)) {
          void actionService.dispatch(
            "terminal.convertType",
            { terminalId, type: targetType as TerminalType },
            { source: "context-menu" }
          );
        }
        return;
      }

      switch (actionId) {
        case "copy":
          void actionService.dispatch("terminal.copy", { terminalId }, { source: "context-menu" });
          break;
        case "paste":
          void actionService.dispatch("terminal.paste", { terminalId }, { source: "context-menu" });
          break;
        case "move-to-dock":
          void actionService.dispatch(
            "terminal.moveToDock",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "move-to-grid":
          void actionService.dispatch(
            "terminal.moveToGrid",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "toggle-maximize":
          void actionService.dispatch(
            "terminal.toggleMaximize",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "restart":
          void actionService.dispatch(
            "terminal.restart",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "redraw":
          void actionService.dispatch(
            "terminal.redraw",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "force-resume":
          void actionService.dispatch(
            "terminal.forceResume",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "toggle-input-lock":
          void actionService.dispatch(
            "terminal.toggleInputLock",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "toggle-watch":
          void actionService.dispatch("terminal.watch", { terminalId }, { source: "context-menu" });
          break;
        case "duplicate":
          void actionService.dispatch(
            "terminal.duplicate",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "rename":
          void actionService.dispatch(
            "terminal.rename",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "view-info":
          void actionService.dispatch(
            "terminal.viewInfo",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "background":
          void actionService.dispatch(
            "terminal.background",
            { terminalId },
            { source: "context-menu" }
          );
          break;
        case "trash":
          void actionService.dispatch("terminal.trash", { terminalId }, { source: "context-menu" });
          break;
        case "kill":
          void actionService.dispatch("terminal.kill", { terminalId }, { source: "context-menu" });
          break;
        case "reload-browser":
          void actionService.dispatch("browser.reload", { terminalId }, { source: "context-menu" });
          break;
        case "open-external":
          if (terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl)) {
            void actionService.dispatch(
              "browser.openExternal",
              { url: terminal.browserUrl },
              { source: "context-menu" }
            );
          }
          break;
        case "copy-url":
          if (terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl)) {
            void actionService.dispatch(
              "browser.copyUrl",
              { url: terminal.browserUrl },
              { source: "context-menu" }
            );
          }
          break;
        case "delete-note":
          if (terminal.notePath) {
            void actionService.dispatch(
              "terminal.deleteNote",
              {
                terminalId,
                notePath: terminal.notePath,
                noteTitle: terminal.title,
              },
              { source: "context-menu", confirmed: true }
            );
          }
          break;
        case "reveal-in-palette":
          if (terminal.notePath) {
            void actionService.dispatch(
              "notes.reveal",
              { notePath: terminal.notePath },
              { source: "context-menu" }
            );
          }
          break;
        case "create-note": {
          const agentConfig = terminal.agentId ? getAgentConfig(terminal.agentId) : null;
          const agentName = agentConfig?.name ?? terminal.agentId ?? "Agent";
          const currentWorktree = worktrees.find((wt) => wt.id === terminal.worktreeId);
          const worktreeName = currentWorktree
            ? (currentWorktree.isMainWorktree
                ? currentWorktree.name
                : currentWorktree.branch || currentWorktree.name
              ).trim() || undefined
            : undefined;
          const noteArgs = buildCreateNoteArgs(
            agentName,
            worktreeName,
            selectionText,
            terminal.worktreeId
          );
          void actionService.dispatch(
            "notes.create",
            { ...noteArgs, openPanel: true },
            { source: "context-menu" }
          );
          break;
        }
      }
    },
    [terminal, terminalId, selectionText, worktrees]
  );

  if (!terminal) {
    return <div className="contents">{children}</div>;
  }

  const isBrowser = terminal.kind === "browser";
  const isNotes = terminal.kind === "notes";
  const isDevPreview = terminal.kind === "dev-preview";
  const hasPty = terminal.kind ? panelKindHasPty(terminal.kind) : true;

  const currentAgentId = terminal.agentId ?? (terminal.type !== "terminal" ? terminal.type : null);
  const isPlainTerminal = terminal.type === "terminal" || terminal.kind === "terminal";

  const layoutSection = (
    <>
      {worktrees.length > 1 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <WorktreeIcon className={ICON_CLASS} />
            Move to Worktree
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {worktrees.map((wt) => {
              const isCurrent = wt.id === terminal.worktreeId;
              const label =
                (wt.isMainWorktree ? wt.name : wt.branch || wt.name).trim() || "Untitled worktree";
              return (
                <ContextMenuItem
                  key={wt.id}
                  disabled={isCurrent}
                  onSelect={() => handleAction(`move-to-worktree:${wt.id}`)}
                >
                  <WorktreeIcon className={ICON_CLASS} />
                  {label}
                </ContextMenuItem>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuItem
        onSelect={() => handleAction(currentLocation === "grid" ? "move-to-dock" : "move-to-grid")}
      >
        {currentLocation === "grid" ? (
          <MoveToDockIcon className={ICON_CLASS} />
        ) : (
          <MoveToGridIcon className={ICON_CLASS} />
        )}
        {currentLocation === "grid" ? "Move to Dock" : "Move to Grid"}
      </ContextMenuItem>
      {currentLocation === "grid" && (
        <ContextMenuItem onSelect={() => handleAction("toggle-maximize")}>
          {isMaximized ? (
            <Minimize2 className={ICON_CLASS} aria-hidden="true" />
          ) : (
            <Maximize2 className={ICON_CLASS} aria-hidden="true" />
          )}
          {isMaximized ? "Restore Size" : "Maximize"}
          <ContextMenuShortcut>^⇧F</ContextMenuShortcut>
        </ContextMenuItem>
      )}
    </>
  );

  if (isBrowser) {
    const hasUrl = Boolean(terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl));
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="contents" data-context-trigger={terminalId}>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("reload-browser")}>
            <RefreshCw className={ICON_CLASS} aria-hidden="true" />
            Reload Page
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("open-external")}>
            <Globe className={ICON_CLASS} aria-hidden="true" />
            Open in Browser
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("copy-url")}>
            <Link className={ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate Browser
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename Browser
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to Background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Close Browser
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Remove Browser
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  if (isNotes) {
    const hasNotePath = Boolean(terminal.notePath);
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="contents" data-context-trigger={terminalId}>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!hasNotePath} onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename Note
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!hasNotePath}
            onSelect={() => handleAction("reveal-in-palette")}
          >
            <Search className={ICON_CLASS} aria-hidden="true" />
            Reveal in Notes Palette
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to Background
          </ContextMenuItem>
          <ContextMenuItem
            destructive
            disabled={!hasNotePath}
            onSelect={() => handleAction("delete-note")}
          >
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Delete Note
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Close Note
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  if (isDevPreview) {
    const hasUrl = Boolean(terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl));
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="contents" data-context-trigger={terminalId}>
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("reload-browser")}>
            <RefreshCw className={ICON_CLASS} aria-hidden="true" />
            Reload Preview
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("open-external")}>
            <Globe className={ICON_CLASS} aria-hidden="true" />
            Open in Browser
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("copy-url")}>
            <Link className={ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate Dev Preview
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename Dev Preview
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to Background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Close Dev Preview
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Stop Dev Server
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  const showConvertTo = !isPlainTerminal || !!currentAgentId || AGENT_IDS.length > 0;

  const convertToItems = (
    <>
      {(!isPlainTerminal || !!currentAgentId) && (
        <ContextMenuItem onSelect={() => handleAction("convert-to:terminal")}>
          <SquareTerminal className={ICON_CLASS} aria-hidden="true" />
          Terminal
        </ContextMenuItem>
      )}
      {AGENT_IDS.map((agentId) => {
        const config = getAgentConfig(agentId);
        if (!config) return null;
        const isCurrent = currentAgentId === agentId;
        return (
          <ContextMenuItem
            key={agentId}
            disabled={isCurrent}
            onSelect={() => handleAction(`convert-to:${agentId}`)}
          >
            <CanopyAgentIcon className={ICON_CLASS} />
            {config.name}
          </ContextMenuItem>
        );
      })}
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="contents"
          data-context-trigger={terminalId}
          onContextMenu={handleContextMenu}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {hasPty && (
          <>
            <ContextMenuItem disabled={!hasSelection} onSelect={() => handleAction("copy")}>
              <Copy className={ICON_CLASS} aria-hidden="true" />
              Copy
              <ContextMenuShortcut>{modifierKey}C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => handleAction("paste")}>
              <Clipboard className={ICON_CLASS} aria-hidden="true" />
              Paste
              <ContextMenuShortcut>{isMac ? `${modifierKey}V` : "Ctrl+⇧V"}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!hasSelection}
              onSelect={() =>
                void actionService.dispatch(
                  "terminal.sendToAgent",
                  { terminalId },
                  { source: "context-menu" }
                )
              }
            >
              <Send className={ICON_CLASS} aria-hidden="true" />
              Send to Agent
              <ContextMenuShortcut>{isMac ? "⌘⇧E" : "Ctrl+⇧E"}</ContextMenuShortcut>
            </ContextMenuItem>
            {hoveredUrl && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => handleAction(`open-link:${hoveredUrl}`)}>
                  <ExternalLink className={ICON_CLASS} aria-hidden="true" />
                  Open Link
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleAction(`copy-link:${hoveredUrl}`)}>
                  <Link className={ICON_CLASS} aria-hidden="true" />
                  Copy Link Address
                </ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
          </>
        )}
        {layoutSection}
        <ContextMenuSeparator />
        {hasPty && (
          <ContextMenuItem onSelect={() => handleAction("restart")}>
            <RotateCcw className={ICON_CLASS} aria-hidden="true" />
            Restart Terminal
          </ContextMenuItem>
        )}
        {hasPty && (
          <ContextMenuItem onSelect={() => handleAction("redraw")}>
            <RefreshCw className={ICON_CLASS} aria-hidden="true" />
            Redraw Terminal
          </ContextMenuItem>
        )}
        {isPaused && (
          <ContextMenuItem onSelect={() => handleAction("force-resume")}>
            <Play className={ICON_CLASS} aria-hidden="true" />
            Force Resume (Paused)
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => handleAction("toggle-input-lock")}>
          {terminal.isInputLocked ? (
            <Unlock className={ICON_CLASS} aria-hidden="true" />
          ) : (
            <Lock className={ICON_CLASS} aria-hidden="true" />
          )}
          {terminal.isInputLocked ? "Unlock Input" : "Lock Input"}
        </ContextMenuItem>
        {terminal.agentId && (
          <ContextMenuItem onSelect={() => handleAction("toggle-watch")}>
            {isWatched ? (
              <BellOff className={ICON_CLASS} aria-hidden="true" />
            ) : (
              <Bell className={ICON_CLASS} aria-hidden="true" />
            )}
            {isWatched ? "Cancel Watch" : "Watch Terminal"}
            <ContextMenuShortcut>{isMac ? "⌘⇧W" : "Ctrl+⇧W"}</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {terminal.agentId && (
          <ContextMenuItem onSelect={() => handleAction("create-note")}>
            <NotebookPen className={ICON_CLASS} aria-hidden="true" />
            Create Note
          </ContextMenuItem>
        )}
        {showConvertTo && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Repeat2 className={ICON_CLASS} aria-hidden="true" />
              Convert to
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>{convertToItems}</ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleAction("duplicate")}>
          <CopyPlus className={ICON_CLASS} aria-hidden="true" />
          Duplicate Terminal
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleAction("rename")}>
          <Pencil className={ICON_CLASS} aria-hidden="true" />
          Rename Terminal
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleAction("view-info")}>
          <Info className={ICON_CLASS} aria-hidden="true" />
          View Terminal Info
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleAction("background")}>
          <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
          Send to Background
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleAction("trash")}>
          <Trash2 className={ICON_CLASS} aria-hidden="true" />
          Trash Terminal
        </ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
          <OctagonX className={ICON_CLASS} aria-hidden="true" />
          Kill Terminal
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
