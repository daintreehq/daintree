import { useState } from "react";
import { SendHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { selectDiffNotes, useDiffNotesStore } from "@/store/diffNotesStore";
import {
  deliverDiffNotes,
  useDiffNoteTargets,
  type DiffNoteDeliveryResult,
} from "@/hooks/useDiffNoteDelivery";

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
          className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] text-xs text-text-secondary transition-colors hover:text-text-primary hover:bg-border-default"
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
          <DropdownMenuRadioItem value="file" onSelect={(event) => event.preventDefault()}>
            <span className="flex flex-1 items-center gap-2">
              This file
              <span className="ml-auto text-3xs tabular-nums text-text-secondary">{fileCount}</span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="all" onSelect={(event) => event.preventDefault()}>
            <span className="flex flex-1 items-center gap-2">
              All files
              <span className="ml-auto text-3xs tabular-nums text-text-secondary">
                {allNotes.length}
              </span>
            </span>
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
    return <DropdownMenuItem disabled>No agents running</DropdownMenuItem>;
  }
  return (
    <>
      {targets.map((target) => (
        <DropdownMenuItem
          key={target.id}
          disabled={disabled || target.isInputLocked}
          onSelect={() => onSend(target.id)}
        >
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
