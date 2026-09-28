import { useState } from "react";
import { SendHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { selectDiffNotes, useDiffNotesStore } from "@/store/diffNotesStore";
import {
  deliverDiffNotes,
  useDiffNoteTargets,
  type DiffNoteDeliveryResult,
} from "@/hooks/useDiffNoteDelivery";
import { PANE_TOOLBAR_TEXT_BUTTON_CLASS } from "@/components/ui/paneToolbarStyles";

export type DiffNoteSendScope = "file" | "all";

/** Everything a send needs, so a retry re-aims at what failed, not what's on screen now. */
export interface DiffNoteSendRequest {
  targetId: string;
  scope: DiffNoteSendScope;
  worktreePath: string;
  filePath: string;
}

interface DiffNotesSendMenuProps {
  worktreePath: string;
  /** Worktree-relative path of the file on screen; "" when none is. */
  filePath: string;
  onResult: (request: DiffNoteSendRequest, result: DiffNoteDeliveryResult) => void;
}

/**
 * Sends a worktree's pending notes into an agent's composer. Scope defaults to
 * the file on screen; "All files" is a deliberate second choice because it
 * reaches notes the reviewer can't see from here.
 */
export function DiffNotesSendMenu({ worktreePath, filePath, onResult }: DiffNotesSendMenuProps) {
  const allNotes = useDiffNotesStore(useShallow((state) => selectDiffNotes(state, worktreePath)));
  const fileCount = allNotes.filter((note) => note.filePath === filePath).length;
  const [scope, setScope] = useState<DiffNoteSendScope>("file");

  if (allNotes.length === 0) return null;

  // "All files" is only ever chosen, never fallen back to: it can reach notes
  // the reviewer can't see from here.
  const count = scope === "file" ? fileCount : allNotes.length;

  const send = (targetId: string) => {
    const request: DiffNoteSendRequest = { targetId, scope, worktreePath, filePath };
    onResult(request, sendDiffNotes(request));
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setScope("file");
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="diff-notes-send"
          className={PANE_TOOLBAR_TEXT_BUTTON_CLASS}
        >
          <SendHorizontal className={TOOLBAR_ICON_CLASS} aria-hidden="true" />
          Send notes
          <span className="tabular-nums">{allNotes.length}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-[220px]">
        <DropdownMenuLabel>Notes to send</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Notes to send"
          value={scope}
          onValueChange={(value) => setScope(value === "all" ? "all" : "file")}
        >
          <DropdownMenuRadioItem
            value="file"
            aria-label={`This file, ${fileCount} ${fileCount === 1 ? "note" : "notes"}`}
            onSelect={(event) => event.preventDefault()}
          >
            This file
            <DropdownMenuMeta>{fileCount}</DropdownMenuMeta>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="all"
            aria-label={`All files, ${allNotes.length} ${allNotes.length === 1 ? "note" : "notes"}`}
            onSelect={(event) => event.preventDefault()}
          >
            All files
            <DropdownMenuMeta>{allNotes.length}</DropdownMenuMeta>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {count === 0
            ? "No notes on this file"
            : `Paste ${count} ${count === 1 ? "note" : "notes"} into`}
        </DropdownMenuLabel>
        <DiffNoteTargetItems disabled={count === 0} onSend={send} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Mounted only while the menu is open, so a closed pane holds no subscription
// to the panel map.
function DiffNoteTargetItems({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (targetId: string) => void;
}) {
  const targets = useDiffNoteTargets();
  if (targets.length === 0) {
    return (
      <DropdownMenuItem inset disabled>
        No agents running
      </DropdownMenuItem>
    );
  }
  return (
    <>
      {targets.map((target) => (
        // Each agent leads with its own mark, which lands the label on the
        // scope rows' label edge above.
        <DropdownMenuItem
          key={target.id}
          disabled={disabled || target.isInputLocked}
          onSelect={() => onSend(target.id)}
        >
          <TerminalIcon
            kind={target.kind}
            chrome={target.chrome}
            className="mr-2 h-3.5 w-3.5 shrink-0"
          />
          <span className="truncate">{target.title}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** Resolves the scope against the store at send time, not at menu render. */
export function sendDiffNotes(request: DiffNoteSendRequest): DiffNoteDeliveryResult {
  const { targetId, scope, worktreePath, filePath } = request;
  const notes = selectDiffNotes(
    useDiffNotesStore.getState(),
    worktreePath,
    scope === "file" ? filePath : undefined
  );
  return deliverDiffNotes(targetId, notes);
}
